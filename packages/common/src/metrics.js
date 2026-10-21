import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['service', 'method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export function httpMetricsMiddleware(service) {
  return (req, res, next) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      // Use the matched route pattern (e.g. /bookings/:id), never the raw URL, to keep label cardinality bounded.
      const route = req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      end({ service, method: req.method, route, status: String(res.statusCode) });
    });
    next();
  };
}

export const metricsHandler = async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.send(await registry.metrics());
};

export function counter(name, help, labelNames = []) {
  return new client.Counter({ name, help, labelNames, registers: [registry] });
}

export function histogram(name, help, buckets, labelNames = []) {
  return new client.Histogram({ name, help, buckets, labelNames, registers: [registry] });
}
