/**
 * Atomically locks ALL requested seats or NONE of them.
 * Returns the 1-based positions of seats already held by someone else (empty = success).
 * Re-acquiring seats you already hold just refreshes their TTL.
 */
const ACQUIRE_LUA = `
local conflicts = {}
for i, key in ipairs(KEYS) do
  local holder = redis.call('GET', key)
  if holder and holder ~= ARGV[1] then
    table.insert(conflicts, i)
  end
end
if #conflicts > 0 then
  return conflicts
end
for _, key in ipairs(KEYS) do
  redis.call('SET', key, ARGV[1], 'PX', ARGV[2])
end
return {}
`;

/** Compare-and-delete: only the holder may release a lock (never delete someone else's hold). */
const RELEASE_LUA = `
local released = 0
for _, key in ipairs(KEYS) do
  if redis.call('GET', key) == ARGV[1] then
    redis.call('DEL', key)
    released = released + 1
  end
end
return released
`;

/**
 * Temporary seat holds in Redis.
 *
 * Why Redis and not just the database? Holds are short-lived, extremely contended (everyone
 * clicks the same centre seats at 10:00 when bookings open) and should vanish on their own
 * if a user walks away — a TTL does that for free. Postgres stays the source of truth for
 * seats that are actually SOLD, enforced by a conditional UPDATE at confirmation time.
 *
 * Keys use a hash tag ({showId}) so all seats of a show map to the same Redis Cluster slot —
 * a requirement for multi-key Lua scripts if we ever shard Redis.
 */
export class SeatLockManager {
  constructor(redis) {
    this.redis = redis;
    redis.defineCommand('seatAcquire', { lua: ACQUIRE_LUA });
    redis.defineCommand('seatRelease', { lua: RELEASE_LUA });
    this.cmd = redis;
  }

  static key(showId, seatId) {
    return `seatlock:{${showId}}:${seatId}`;
  }

  async acquire(showId, seatIds, holderId, ttlMs) {
    const keys = seatIds.map((s) => SeatLockManager.key(showId, s));
    const conflicts = await this.cmd.seatAcquire(keys.length, ...keys, holderId, ttlMs);
    if (conflicts.length === 0) return { ok: true };
    return { ok: false, conflicts: conflicts.map((i) => seatIds[i - 1]) };
  }

  async release(showId, seatIds, holderId) {
    if (!seatIds.length) return 0;
    const keys = seatIds.map((s) => SeatLockManager.key(showId, s));
    return this.cmd.seatRelease(keys.length, ...keys, holderId);
  }

  /** Who currently holds each seat (null = free). One round trip via MGET. */
  async holders(showId, seatIds) {
    if (!seatIds.length) return new Map();
    const values = await this.redis.mget(seatIds.map((s) => SeatLockManager.key(showId, s)));
    return new Map(seatIds.map((s, i) => [s, values[i] ?? null]));
  }
}
