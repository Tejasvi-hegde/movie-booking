import { randomUUID } from 'node:crypto';

/**
 * Sliding-window-log rate limiter in Redis.
 *
 * Each request is a member in a sorted set scored by its timestamp. On every call we drop
 * entries older than the window and count what is left. Unlike a fixed window counter this
 * has no "2x burst at the window boundary" problem. The whole check-and-add runs in one Lua
 * script, so it is atomic across all gateway replicas.
 */
const SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2])}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, count + 1, 0}
`;

export class SlidingWindowRateLimiter {
  constructor(redis) {
    this.redis = redis;
    this.redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
  }

  async hit(key, limit, windowMs, now = Date.now()) {
    const [allowed, count, oldest] = await this.redis.slidingWindow(key, now, windowMs, limit, `${now}-${randomUUID()}`);
    return {
      allowed: allowed === 1,
      remaining: Math.max(0, limit - count),
      retryAfterMs: allowed === 1 ? 0 : Math.max(0, oldest + windowMs - now),
    };
  }
}

const identity = (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`);

export function rateLimitMiddleware(limiter, rules, logger) {
  return async (req, res, next) => {
    try {
      let tightest;
      for (const rule of rules) {
        if (!rule.match(req)) continue;
        const who = (rule.key ?? identity)(req);
        const result = await limiter.hit(`rl:${rule.name}:${who}`, rule.limit, rule.windowMs);
        if (!tightest || result.remaining < tightest.remaining) tightest = { rule, remaining: result.remaining };
        // Report the rule closest to its limit, so clients see the constraint that will bite first.
        res.setHeader('RateLimit-Policy', `${tightest.rule.limit};w=${tightest.rule.windowMs / 1000};name="${tightest.rule.name}"`);
        res.setHeader('RateLimit-Remaining', String(tightest.remaining));
        if (!result.allowed) {
          const retryAfter = Math.ceil(result.retryAfterMs / 1000);
          res.setHeader('Retry-After', String(retryAfter));
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests, slow down',
              details: { rule: rule.name, retryAfterSeconds: retryAfter },
            },
          });
          return;
        }
      }
    } catch (err) {
      // Fail open: a Redis blip should degrade protection, not take the whole site down.
      logger.warn({ err: err.message }, 'Rate limiter unavailable, allowing request');
    }
    next();
  };
}
