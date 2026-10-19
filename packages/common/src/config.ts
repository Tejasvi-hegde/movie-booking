import { z } from 'zod';

/** Fields every service shares. Service-specific fields are merged on top. */
export const baseConfigShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /**
   * Shared secret the gateway attaches to every proxied request and services attach to
   * service-to-service calls. Services reject requests without it, so nobody can bypass
   * the gateway and forge the x-user-* identity headers.
   */
  INTERNAL_TOKEN: z.string().min(16).default('dev-internal-token-change-me'),
};

/**
 * Parses process.env against a zod shape. Fails fast with a readable message
 * instead of crashing later with "undefined is not a function".
 */
export function loadConfig<T extends z.ZodRawShape>(shape: T, env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({ ...baseConfigShape, ...shape });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data as z.infer<typeof schema>;
}
