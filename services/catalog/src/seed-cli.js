// Seeds the catalog without starting the HTTP server: `npm run seed`.
import { createLogger, createRedis } from '@showtime/common';
import { CatalogCache } from './cache.js';
import { CatalogService } from './catalog-service.js';
import { config } from './config.js';
import { connectMongo } from './db.js';
import { seedCatalog } from './seed.js';

const logger = createLogger('catalog-seed', 'info');
const db = await connectMongo(config.MONGO_URL);
const redis = createRedis(config.REDIS_URL, logger);
const catalog = new CatalogService(db, new CatalogCache(redis, config.CACHE_TTL_SECONDS, logger), logger);
await seedCatalog(db, catalog, logger, config.SEED_DAYS_AHEAD);
logger.info('Seed complete. Start the catalog service to publish the show events.');
await db.client.close();
await redis.quit();
