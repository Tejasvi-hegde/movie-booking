import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  const pretty = process.env.NODE_ENV === 'development' && process.env.LOG_PRETTY !== 'false';
  return pino({
    name: service,
    level,
    base: { service },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-internal-token"]', '*.password'],
      censor: '[redacted]',
    },
    ...(pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }
      : {}),
  });
}
