import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(4005),
  /** smtp = send real email (Mailpit in docker-compose catches it), console = log only. */
  EMAIL_TRANSPORT: z.enum(['smtp', 'console']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  MAIL_FROM: z.string().default('Showtime <tickets@showtime.dev>'),
});
