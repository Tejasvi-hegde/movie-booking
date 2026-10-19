import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(4002),
  MONGO_URL: z.string().default('mongodb://localhost:27017/showtime_catalog'),
  CACHE_TTL_SECONDS: z.coerce.number().default(60),
  /** Seeds demo movies/venues and keeps the next few days of shows scheduled. */
  SEED_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SEED_DAYS_AHEAD: z.coerce.number().default(5),
});
