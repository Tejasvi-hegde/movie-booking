import { loadConfig } from '@showtime/common';
import { z } from 'zod';

export const config = loadConfig({
  PORT: z.coerce.number().default(4004),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/showtime_payment'),
  BOOKING_URL: z.string().url().default('http://localhost:4003'),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  MOCK_WEBHOOK_SECRET: z.string().min(8).default('dev-mock-webhook-secret'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});
