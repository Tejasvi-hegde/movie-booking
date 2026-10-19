/**
 * Concurrency test: proves the system never double-books a seat.
 *
 *   RATE_LIMIT_ENABLED=false on the gateway (all virtual users share one IP), then:
 *   npm run race                       # defaults
 *   USERS=200 CHAOS_SECONDS=20 npm run race
 *
 * Scenario 1 — "the same seat at the same millisecond": N users fire a hold for one seat at once.
 *              Exactly one must win; everyone else gets 409.
 * Scenario 2 — "chaos": N users hammer a small pool of seats for a while, holding random seat
 *              combinations and paying (some payments fail). Afterwards no seat may belong to
 *              more than one confirmed booking, and the seat map must agree with the bookings.
 */
import assert from 'node:assert/strict';
import { api, findBookableShow, newKey, register, waitFor } from './lib/client.js';

const USERS = Number(process.env.USERS ?? 100);
const CHAOS_SECONDS = Number(process.env.CHAOS_SECONDS ?? 15);
const POOL_SIZE = Number(process.env.POOL_SIZE ?? 12);

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

async function inBatches<T>(n: number, size: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i += size) out.push(...(await Promise.all(Array.from({ length: Math.min(size, n - i) }, (_, j) => fn(i + j)))));
  return out;
}

console.log(`\nShowtime race test — ${USERS} users\n`);
const users = await inBatches(USERS, 25, () => register('racer'));
console.log(`  · registered ${users.length} users`);

// ── Scenario 1 ────────────────────────────────────────────────────────────────
{
  const { showId } = await findBookableShow('Bengaluru', 3);
  const map = await api('GET', `/api/bookings/shows/${showId}/seats`);
  const seat = map.body.seats.find((s: { status: string }) => s.status === 'AVAILABLE').seatId as string;
  console.log(`\n  Scenario 1: ${USERS} users → seat ${seat} of show ${showId.slice(0, 8)} at the same instant`);

  const start = Date.now();
  const results = await Promise.all(
    users.map(async (u) => {
      const t = Date.now();
      const r = await api('POST', '/api/bookings/holds', { token: u.token, body: { showId, seatIds: [seat] } });
      return { user: u, status: r.status, body: r.body, ms: Date.now() - t };
    }),
  );
  if (results.some((r) => r.status === 429)) throw new Error('Hit the rate limiter — start the gateway with RATE_LIMIT_ENABLED=false');
  const winners = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const other = results.filter((r) => r.status !== 201 && r.status !== 409);
  console.log(`    201 Created: ${winners.length}   409 Conflict: ${conflicts.length}   other: ${other.length}   (${Date.now() - start}ms total, p95 ${pct(results.map((r) => r.ms), 95)}ms)`);
  assert.equal(winners.length, 1, 'exactly one user must win the seat');
  assert.equal(other.length, 0, `unexpected responses: ${JSON.stringify(other.slice(0, 3).map((o) => o.body))}`);

  const w = winners[0]!;
  const pay = await api('POST', '/api/payments/intents', { token: w.user.token, idempotencyKey: newKey(), body: { bookingId: w.body.id } });
  await api('POST', `/api/payments/${pay.body.id}/mock/complete`, { token: w.user.token, body: { outcome: 'success' } });
  await waitFor('winner confirmed', async () => (await api('GET', `/api/bookings/${w.body.id}`, { token: w.user.token })).body.status === 'CONFIRMED');
  console.log('    ✓ exactly one hold succeeded and it was confirmed');
}

// ── Scenario 2 ────────────────────────────────────────────────────────────────
{
  const { showId } = await findBookableShow('Bengaluru', 4);
  const map = await api('GET', `/api/bookings/shows/${showId}/seats`);
  const pool: string[] = map.body.seats.filter((s: { status: string }) => s.status === 'AVAILABLE').slice(0, POOL_SIZE).map((s: { seatId: string }) => s.seatId);
  console.log(`\n  Scenario 2: ${USERS} users × ${CHAOS_SECONDS}s fighting over ${pool.length} seats (${pool.join(' ')})`);

  const stats = { holds: 0, held: 0, conflicts: 0, paid: 0, failedPayments: 0, errors: 0 };
  const holdLatency: number[] = [];
  const deadline = Date.now() + CHAOS_SECONDS * 1000;

  await Promise.all(
    users.map(async (u) => {
      while (Date.now() < deadline) {
        const want = [...pool].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
        const t = Date.now();
        const hold = await api('POST', '/api/bookings/holds', { token: u.token, body: { showId, seatIds: want } });
        holdLatency.push(Date.now() - t);
        stats.holds++;
        if (hold.status === 409) {
          stats.conflicts++;
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
          continue;
        }
        if (hold.status !== 201) {
          stats.errors++;
          continue;
        }
        stats.held++;
        const pay = await api('POST', '/api/payments/intents', { token: u.token, idempotencyKey: newKey(), body: { bookingId: hold.body.id } });
        if (pay.status !== 201) {
          stats.errors++;
          continue;
        }
        const fail = Math.random() < 0.2;
        await api('POST', `/api/payments/${pay.body.id}/mock/complete`, { token: u.token, body: { outcome: fail ? 'failure' : 'success' } });
        if (fail) stats.failedPayments++;
        else stats.paid++;
      }
    }),
  );
  console.log(`    holds tried ${stats.holds}, granted ${stats.held}, conflicts ${stats.conflicts}, paid ${stats.paid}, failed payments ${stats.failedPayments}, errors ${stats.errors}`);
  console.log(`    hold latency p50 ${pct(holdLatency, 50)}ms · p95 ${pct(holdLatency, 95)}ms · p99 ${pct(holdLatency, 99)}ms`);

  // Let the event pipeline settle (all payment events → confirmations / refunds).
  await new Promise((r) => setTimeout(r, 3000));

  const lists = await inBatches(users.length, 25, async (i) => {
    const r = await api('GET', '/api/bookings/me', { token: users[i]!.token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as { showId: string; status: string; seats: string[] }[];
  });
  const all = lists.flat();
  const confirmed = all.filter((b) => b.showId === showId && b.status === 'CONFIRMED');
  const owner = new Map<string, number>();
  for (const b of confirmed) for (const s of b.seats) owner.set(s, (owner.get(s) ?? 0) + 1);
  const doubles = [...owner.entries()].filter(([, n]) => n > 1);
  const failedWithRefund = all.filter((b) => b.showId === showId && b.status === 'FAILED').length;

  const finalMap = await api('GET', `/api/bookings/shows/${showId}/seats`);
  // Only this run's pool (seats free at the start) — earlier runs may have sold other seats.
  const bookedInMap = new Set<string>(
    finalMap.body.seats.filter((s: { status: string; seatId: string }) => s.status === 'BOOKED' && pool.includes(s.seatId)).map((s: { seatId: string }) => s.seatId),
  );

  console.log(`    confirmed bookings: ${confirmed.length} covering ${owner.size} seats · failed bookings: ${failedWithRefund}`);
  assert.equal(doubles.length, 0, `DOUBLE BOOKED: ${JSON.stringify(doubles)}`);
  assert.deepEqual([...bookedInMap].sort(), [...owner.keys()].sort(), 'seat map and confirmed bookings disagree');
  console.log('    ✓ zero double bookings; seat inventory matches confirmed bookings exactly');
}

console.log('\n\x1b[32mRace test passed\x1b[0m\n');
