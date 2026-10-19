import { fileURLToPath } from 'node:url';
import {
  addReadinessRoute,
  createLogger,
  createPool,
  createServiceApp,
  ensureDatabase,
  finalizeApp,
  runMigrations,
  runService,
} from '@showtime/common';
import { AuthService } from './auth-service.js';
import { config } from './config.js';
import { authRoutes } from './routes.js';

const logger = createLogger('auth', config.LOG_LEVEL);

await ensureDatabase(config.DATABASE_URL);
const pool = createPool(config.DATABASE_URL);
await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), logger);

const auth = new AuthService(
  pool,
  {
    jwtSecret: config.JWT_SECRET,
    accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  },
  logger,
);
await auth.ensureUser(config.ADMIN_EMAIL, config.ADMIN_PASSWORD, 'Admin', 'ADMIN');
if (config.SEED_DEMO_USER) await auth.ensureUser('demo@showtime.dev', 'demo1234', 'Demo User', 'USER');

const app = createServiceApp({ name: 'auth', logger, internalToken: config.INTERNAL_TOKEN });
addReadinessRoute(app, { postgres: () => pool.query('SELECT 1') });
app.use('/auth', authRoutes(auth, { secure: config.COOKIE_SECURE, path: config.COOKIE_PATH }));
finalizeApp(app, logger);

runService({ app, port: config.PORT, logger, shutdown: [() => pool.end()] });
