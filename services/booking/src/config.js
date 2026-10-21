import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(4003),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/showtime_booking'),
  HOLD_TTL_SECONDS: z.coerce.number().int().min(30).default(300),
  HOLD_GRACE_SECONDS: z.coerce.number().int().min(0).default(60),
  MAX_SEATS_PER_BOOKING: z.coerce.number().int().min(1).max(20).default(10),
  CANCELLATION_CUTOFF_HOURS: z.coerce.number().min(0).default(2),
  CONVENIENCE_FEE_PAISE: z.coerce.number().int().min(0).default(30_00),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
});
