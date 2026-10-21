import { hostname } from 'node:os';
import {
  addReadinessRoute,
  createLogger,
  createRedis,
  createServiceApp,
  EventConsumer,
  finalizeApp,
  requireUser,
  runService,
} from '@showtime/common';
import { ConsoleEmailChannel, EmailChannel, InAppChannel } from './channels.js';
import { config } from './config.js';
import { NotificationDispatcher } from './dispatcher.js';

const logger = createLogger('notification', config.LOG_LEVEL);
const redis = createRedis(config.REDIS_URL, logger, 'notification');

const inApp = new InAppChannel(redis);
const email =
  config.EMAIL_TRANSPORT === 'smtp'
    ? new EmailChannel(config.SMTP_HOST, config.SMTP_PORT, config.MAIL_FROM)
    : new ConsoleEmailChannel(logger);
const dispatcher = new NotificationDispatcher(redis, [inApp, email], logger);

const handle = (e) => dispatcher.handle(e);
const consumer = new EventConsumer({ redis: redis.duplicate(), group: 'notification', consumer: `${hostname()}-${process.pid}`, logger })
  .on('booking.confirmed', handle)
  .on('booking.failed', handle)
  .on('booking.expired', handle)
  .on('booking.cancelled', handle)
  .on('payment.refunded', handle);
await consumer.start();

const app = createServiceApp({ name: 'notification', logger, internalToken: config.INTERNAL_TOKEN });
addReadinessRoute(app, { redis: () => redis.ping() });
app.get('/notifications/me', async (req, res) => {
  res.json(await inApp.list(requireUser(req).id));
});
finalizeApp(app, logger);

runService({ app, port: config.PORT, logger, shutdown: [() => consumer.stop(), () => redis.quit()] });
