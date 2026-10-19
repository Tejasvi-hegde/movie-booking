import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export { Redis };

export function createRedis(url: string, logger: Logger, name = 'main'): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    connectionName: name,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on('error', (err) => logger.warn({ err: err.message, connection: name }, 'Redis connection error'));
  return redis;
}
