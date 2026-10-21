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
  ServiceClient,
} from '@showtime/common';
import { config } from './config.js';
import { PaymentService } from './payment-service.js';
import { PaymentProviderFactory } from './providers/provider-factory.js';
import { paymentRoutes } from './routes.js';

const logger = createLogger('payment', config.LOG_LEVEL);

await ensureDatabase(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL);
await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), logger);

const redis = createRedis(config.REDIS_URL, logger, 'payment');
const relay = new OutboxRelay(pool, new EventPublisher(redis), logger);

const razorpay =
  config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET && config.RAZORPAY_WEBHOOK_SECRET
    ? { keyId: config.RAZORPAY_KEY_ID, keySecret: config.RAZORPAY_KEY_SECRET, webhookSecret: config.RAZORPAY_WEBHOOK_SECRET }
    : undefined;
const providers = new PaymentProviderFactory({
  defaultProvider: config.PAYMENT_PROVIDER,
  mockWebhookSecret: config.MOCK_WEBHOOK_SECRET,
  razorpay,
});

const bookingClient = new ServiceClient({ name: 'booking', baseUrl: config.BOOKING_URL, internalToken: config.INTERNAL_TOKEN, logger });
const payments = new PaymentService(pool, providers, bookingClient, relay, logger, razorpay?.keyId);

// Saga participant: react to booking outcomes.
const consumer = new EventConsumer({ redis: redis.duplicate(), group: 'payment', consumer: `${hostname()}-${process.pid}`, logger })
  .on('booking.failed', async ({ data }) => {
    await payments.cancelOpenIntents(data.bookingId);
    if (data.refundRequired && data.paymentId) await payments.refund(data.paymentId, data.reason, data.userEmail);
  })
  .on('booking.cancelled', async ({ data }) => {
    await payments.cancelOpenIntents(data.bookingId);
    if (data.refundRequired && data.paymentId) await payments.refund(data.paymentId, data.reason, data.userEmail);
  })
  .on('booking.expired', async ({ data }) => {
    await payments.cancelOpenIntents(data.bookingId);
  });

await consumer.start();
relay.start();
const cleanup = setInterval(() => void cleanupIdempotencyKeys(pool).catch(() => undefined), 3_600_000);

const app = createServiceApp({ name: 'payment', logger, internalToken: config.INTERNAL_TOKEN, publicPrefixes: ['/payments/webhooks/'] });
addReadinessRoute(app, { postgres: () => pool.query('SELECT 1'), redis: () => redis.ping() });
app.use('/payments', paymentRoutes(payments, pool));
finalizeApp(app, logger);

runService({
  app,
  port: config.PORT,
  logger,
  shutdown: [() => clearInterval(cleanup), () => consumer.stop(), () => relay.stop(), () => pool.end(), () => redis.quit()],
});
