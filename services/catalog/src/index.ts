import { addReadinessRoute, createLogger, createRedis, createServiceApp, EventPublisher, finalizeApp, runService } from '@showtime/common';
import { CatalogCache } from './cache.js';
import { CatalogService } from './catalog-service.js';
import { config } from './config.js';
import { connectMongo } from './db.js';
import { ShowEventRelay } from './event-relay.js';
import { catalogRoutes } from './routes.js';
import { seedCatalog } from './seed.js';

const logger = createLogger('catalog', config.LOG_LEVEL);
const db = await connectMongo(config.MONGO_URL);
const redis = createRedis(config.REDIS_URL, logger, 'catalog');

const cache = new CatalogCache(redis, config.CACHE_TTL_SECONDS, logger);
const catalog = new CatalogService(db, cache, logger);
const relay = new ShowEventRelay(db, new EventPublisher(redis), logger);

if (config.SEED_ON_START) await seedCatalog(db, catalog, logger, config.SEED_DAYS_AHEAD);
relay.start();

// Keep the demo schedule rolling forward while the service runs.
const reseed = config.SEED_ON_START
  ? setInterval(() => void seedCatalog(db, catalog, logger, config.SEED_DAYS_AHEAD).catch((err) => logger.error({ err }, 'Reseed failed')), 3_600_000)
  : undefined;

const app = createServiceApp({ name: 'catalog', logger, internalToken: config.INTERNAL_TOKEN });
addReadinessRoute(app, { mongo: () => db.db.command({ ping: 1 }), redis: () => redis.ping() });
app.use('/catalog', catalogRoutes(catalog));
finalizeApp(app, logger);

runService({
  app,
  port: config.PORT,
  logger,
  shutdown: [() => clearInterval(reseed), () => relay.stop(), () => db.client.close(), () => redis.quit()],
});
