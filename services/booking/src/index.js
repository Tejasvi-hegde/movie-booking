import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addReadinessRoute,
  cleanupIdempotencyKeys,
  createLogger,
  createPool,
  createRedis,
  createServiceApp,
  ensureDatabase,
  EventConsumer,
  EventPublisher,
  finalizeApp,
  OutboxRelay,
  runMigrations,
  runService,
} from '@showtime/common';
import { BookingService } from './booking-service.js';
import { config } from './config.js';
import { PricingEngine } from './domain/pricing.js';
import { bookingRoutes, internalRoutes } from './routes.js';
import { SeatEventHub } from './seat-events.js';
import { SeatLockManager } from './seat-lock.js';

const logger = createLogger('booking', config.LOG_LEVEL);

await ensureDatabase(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL, 20);
await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), logger);

const redis = createRedis(config.REDIS_URL, logger, 'booking');
const relay = new OutboxRelay(pool, new EventPublisher(redis), logger);
const seatEvents = new SeatEventHub(redis, redis.duplicate(), logger);

const bookings = new BookingService(
  pool,
  new SeatLockManager(redis),
  PricingEngine.default(config.CONVENIENCE_FEE_PAISE),
  seatEvents,
  relay,
  {
    holdTtlMs: config.HOLD_TTL_SECONDS * 1000,
    holdGraceMs: config.HOLD_GRACE_SECONDS * 1000,
    maxSeatsPerBooking: config.MAX_SEATS_PER_BOOKING,
    cancellationCutoffMs: config.CANCELLATION_CUTOFF_HOURS * 3_600_000,
  },
  logger,
);

const consumer = new EventConsumer({ redis: redis.duplicate(), group: 'booking', consumer: `${hostname()}-${process.pid}`, logger })
  .on('show.created', (e) => bookings.onShowCreated(e.data))
  .on('show.cancelled', (e) => bookings.onShowCancelled(e.data))
  .on('payment.succeeded', (e) => bookings.onPaymentSucceeded(e.data))
  .on('payment.failed', (e) => bookings.onPaymentFailed(e.data));

await seatEvents.start();
await consumer.start();
relay.start();

let sweeping = true;
const sweep = async () => {
  while (sweeping) {
    await bookings.expireDue().catch((err) => logger.error({ err }, 'Expiry sweep failed'));
    await new Promise((r) => setTimeout(r, config.SWEEP_INTERVAL_MS));
  }
};
void sweep();
const cleanup = setInterval(() => void cleanupIdempotencyKeys(pool).catch(() => undefined), 3_600_000);

const app = createServiceApp({ name: 'booking', logger, internalToken: config.INTERNAL_TOKEN });
addReadinessRoute(app, { postgres: () => pool.query('SELECT 1'), redis: () => redis.ping() });
app.use('/bookings', bookingRoutes(bookings, seatEvents, pool));
app.use('/internal', internalRoutes(bookings));
finalizeApp(app, logger);

runService({
  app,
  port: config.PORT,
  logger,
  shutdown: [
    () => {
      sweeping = false;
      clearInterval(cleanup);
    },
    () => consumer.stop(),
    () => relay.stop(),
    () => seatEvents.stop(),
    () => pool.end(),
    () => redis.quit(),
  ],
});
