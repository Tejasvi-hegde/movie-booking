import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(4001),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/showtime_auth'),
  JWT_SECRET: z.string().min(16).default('dev-jwt-secret-change-me-please'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Path the browser sees (through the gateway), so the cookie is only sent to auth endpoints. */
  COOKIE_PATH: z.string().default('/api/auth'),
  ADMIN_EMAIL: z.string().email().default('admin@showtime.dev'),
  ADMIN_PASSWORD: z.string().min(8).default('admin1234'),
  SEED_DEMO_USER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
