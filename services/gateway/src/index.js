import { randomUUID } from 'node:crypto';
import { createLogger, createRedis, HEADERS, httpMetricsMiddleware, metricsHandler, runService } from '@showtime/common';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';
import { rateLimitMiddleware, SlidingWindowRateLimiter } from './rate-limiter.js';

const logger = createLogger('gateway', config.LOG_LEVEL);
const redis = createRedis(config.REDIS_URL, logger, 'gateway');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: true }));
app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader(HEADERS.requestId, id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/metrics' },
  }),
);
app.use(httpMetricsMiddleware('gateway'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'gateway' });
});
app.get('/metrics', metricsHandler);

// Aggregated health of all downstream services — handy for the README demo and for debugging.
const services = {
  auth: config.AUTH_URL,
  catalog: config.CATALOG_URL,
  booking: config.BOOKING_URL,
  payment: config.PAYMENT_URL,
  notification: config.NOTIFICATION_URL,
};
app.get('/health/services', async (_req, res) => {
  const entries = await Promise.all(
    Object.entries(services).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1500) });
        return [name, { status: r.ok ? 'up' : 'degraded', checks: (await r.json()).checks }];
      } catch {
        return [name, { status: 'down' }];
      }
    }),
  );
  const result = Object.fromEntries(entries);
  const allUp = entries.every(([, v]) => v.status === 'up');
  res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : 'degraded', services: result });
});

const authenticate = (req, res, next) => {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const claims = jwt.verify(header.slice(7), config.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'showtime-auth',
      audience: 'showtime',
    });
    req.user = { id: claims.sub, role: claims.role, email: claims.email, name: claims.name };
    next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    res.status(401).json({
      error: { code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', message: expired ? 'Access token expired' : 'Invalid access token' },
    });
  }
};
app.use('/api', authenticate);

const minute = 60_000;
const rules = [
  // Brute-force protection on credentials, keyed by IP even when a token is present.
  {
    name: 'auth',
    limit: 10,
    windowMs: minute,
    match: (r) => r.method === 'POST' && /^\/api\/auth\/(login|register)$/.test(r.path),
    key: (r) => `ip:${r.ip}`,
  },
  { name: 'holds', limit: 30, windowMs: minute, match: (r) => r.method === 'POST' && r.path === '/api/bookings/holds' },
  { name: 'payments', limit: 20, windowMs: minute, match: (r) => r.method === 'POST' && r.path === '/api/payments/intents' },
  { name: 'global', limit: 600, windowMs: minute, match: (r) => r.path.startsWith('/api/') },
];
if (config.RATE_LIMIT_ENABLED) app.use(rateLimitMiddleware(new SlidingWindowRateLimiter(redis), rules, logger));

// Never trust identity headers from the outside world — strip them, then set our own.
const SPOOFABLE = [HEADERS.userId, HEADERS.userRole, HEADERS.userEmail, HEADERS.userName, HEADERS.internalToken];

function proxy(prefix, target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathFilter: (path) => path === prefix || path.startsWith(`${prefix}/`),
    pathRewrite: { '^/api': '' },
    proxyTimeout: 30_000,
    on: {
      proxyReq: (proxyReq, req) => {
        for (const h of SPOOFABLE) proxyReq.removeHeader(h);
        proxyReq.setHeader(HEADERS.internalToken, config.INTERNAL_TOKEN);
        proxyReq.setHeader(HEADERS.requestId, String(req.id));
        if (req.user) {
          proxyReq.setHeader(HEADERS.userId, req.user.id);
          proxyReq.setHeader(HEADERS.userRole, req.user.role);
          proxyReq.setHeader(HEADERS.userEmail, req.user.email);
          proxyReq.setHeader(HEADERS.userName, encodeURIComponent(req.user.name));
        }
      },
      error: (err, req, res) => {
        logger.error({ err: err.message, path: req.url, target }, 'Upstream unavailable');
        if ('writeHead' in res && !res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'Service temporarily unavailable' } }));
        }
      },
    },
  });
}

app.use(proxy('/api/auth', config.AUTH_URL));
app.use(proxy('/api/catalog', config.CATALOG_URL));
app.use(proxy('/api/bookings', config.BOOKING_URL));
app.use(proxy('/api/payments', config.PAYMENT_URL));
app.use(proxy('/api/notifications', config.NOTIFICATION_URL));

app.use((req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

runService({ app, port: config.PORT, logger, shutdown: [() => redis.quit()] });
