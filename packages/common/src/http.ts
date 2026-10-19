import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { z, type ZodTypeAny } from 'zod';
import { AppError, ForbiddenError, UnauthorizedError, ValidationError } from './errors.js';
import type { Logger } from './logger.js';
import { httpMetricsMiddleware, metricsHandler } from './metrics.js';

export type Role = 'USER' | 'ADMIN';

/** Identity propagated by the gateway after it verifies the JWT. */
export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      rawBody?: Buffer;
    }
  }
}

export const HEADERS = {
  requestId: 'x-request-id',
  internalToken: 'x-internal-token',
  userId: 'x-user-id',
  userRole: 'x-user-role',
  userEmail: 'x-user-email',
  userName: 'x-user-name',
  idempotencyKey: 'idempotency-key',
} as const;

const PUBLIC_PATHS = new Set(['/health', '/ready', '/metrics']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface ServiceAppOptions {
  name: string;
  logger: Logger;
  internalToken: string;
  /** Paths (prefix match) that may be called without the internal token, e.g. provider webhooks. */
  publicPrefixes?: string[];
}

/**
 * Base Express app every service starts from: request ids, structured logs, metrics,
 * JSON parsing (raw body kept for webhook signature checks), internal-token check and
 * identity extraction from gateway headers.
 */
export function createServiceApp({ name, logger, internalToken, publicPrefixes = [] }: ServiceAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers[HEADERS.requestId];
        const id = typeof incoming === 'string' && incoming.length <= 128 ? incoming : randomUUID();
        res.setHeader(HEADERS.requestId, id);
        return id;
      },
      autoLogging: { ignore: (req) => PUBLIC_PATHS.has(req.url ?? '') },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  app.use(httpMetricsMiddleware(name));
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request).rawBody = Buffer.from(buf);
      },
    }),
  );

  // Defence in depth: only the gateway and sibling services know the internal token.
  app.use((req, _res, next) => {
    if (PUBLIC_PATHS.has(req.path) || publicPrefixes.some((p) => req.path.startsWith(p))) return next();
    const token = req.header(HEADERS.internalToken);
    if (!token || !safeEqual(token, internalToken)) {
      return next(new ForbiddenError('Direct access to services is not allowed; go through the gateway'));
    }
    next();
  });

  app.use((req, _res, next) => {
    const id = req.header(HEADERS.userId);
    const role = req.header(HEADERS.userRole);
    if (id && (role === 'USER' || role === 'ADMIN')) {
      req.user = {
        id,
        role,
        email: req.header(HEADERS.userEmail) ?? '',
        name: decodeURIComponent(req.header(HEADERS.userName) ?? ''),
      };
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: name });
  });
  app.get('/metrics', metricsHandler);
  return app;
}

/** Readiness probe: runs dependency checks (DB ping, Redis ping, ...). */
export function addReadinessRoute(app: Express, checks: Record<string, () => Promise<unknown>>): void {
  app.get('/ready', async (_req, res) => {
    const results: Record<string, string> = {};
    let ok = true;
    await Promise.all(
      Object.entries(checks).map(async ([dep, check]) => {
        try {
          await check();
          results[dep] = 'ok';
        } catch (err) {
          ok = false;
          results[dep] = (err as Error).message;
        }
      }),
    );
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks: results });
  });
}

/** Must be registered after all routes. */
export function finalizeApp(app: Express, logger: Logger): void {
  app.use((req, _res, next) => next(new AppError(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}`)));
  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body' } });
      return;
    }
    (req.log ?? logger).error({ err }, 'Unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  };
  app.use(errorHandler);
}

/** Parse + validate an input with zod, throwing a 400 with field-level details on failure. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export function requireUser(req: Request): AuthUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

export function requireAdmin(req: Request): AuthUser {
  const user = requireUser(req);
  if (user.role !== 'ADMIN') throw new ForbiddenError('Admin access required');
  return user;
}

export const adminOnly: RequestHandler = (req, _res, next) => {
  requireAdmin(req);
  next();
};

export const authenticated: RequestHandler = (req, _res, next) => {
  requireUser(req);
  next();
};
