import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(8080),
  JWT_SECRET: z.string().min(16).default('dev-jwt-secret-change-me-please'),
  AUTH_URL: z.string().url().default('http://localhost:4001'),
  CATALOG_URL: z.string().url().default('http://localhost:4002'),
  BOOKING_URL: z.string().url().default('http://localhost:4003'),
  PAYMENT_URL: z.string().url().default('http://localhost:4004'),
  NOTIFICATION_URL: z.string().url().default('http://localhost:4005'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
