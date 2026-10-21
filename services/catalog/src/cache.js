/**
 * Cache-aside with generational invalidation.
 *
 * Every key embeds the current "generation" number. A write bumps the generation (one INCR),
 * which instantly makes every older key unreachable — no need to track and delete every key
 * that a write might affect. Orphaned keys simply expire via their TTL.
 */
export class CatalogCache {
  static GEN_KEY = 'cache:catalog:gen';

  constructor(redis, ttlSeconds, logger) {
    this.redis = redis;
    this.ttlSeconds = ttlSeconds;
    this.logger = logger;
  }

  async getOrLoad(key, load) {
    let fullKey;
    try {
      const gen = (await this.redis.get(CatalogCache.GEN_KEY)) ?? '0';
      fullKey = `cache:catalog:${gen}:${key}`;
      const cached = await this.redis.get(fullKey);
      if (cached) return { value: JSON.parse(cached), hit: true };
    } catch (err) {
      // The cache is an optimisation; if Redis is down we serve from the database.
      this.logger.warn({ err: err.message }, 'Cache read failed');
    }
    const value = await load();
    if (fullKey) {
      this.redis.set(fullKey, JSON.stringify(value), 'EX', this.ttlSeconds).catch(() => undefined);
    }
    return { value, hit: false };
  }

  async invalidateAll() {
    await this.redis.incr(CatalogCache.GEN_KEY).catch((err) => this.logger.warn({ err: err.message }, 'Cache invalidation failed'));
  }
}
