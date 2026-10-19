/**
 * End-to-end test against a running stack (docker compose or `npm run dev`).
 *   npm run e2e
 * Exercises every service through the gateway: happy path, payment failure, cancellation +
 * refund, idempotency, security boundaries and validation.
 */
import assert from 'node:assert/strict';
import { api, findBookableShow, newKey, register, waitFor } from './lib/client.js';

const BOOKING_DIRECT = process.env.BOOKING_URL ?? 'http://localhost:4003';
let passed = 0;

async function step(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} \x1b[2m(${Date.now() - start}ms)\x1b[0m`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    process.exit(1);
  }
}

const seatStatus = async (showId: string, token?: string) => {
  const r = await api('GET', `/api/bookings/shows/${showId}/seats`, { token });
  return new Map<string, string>(r.body.seats.map((s: { seatId: string; status: string }) => [s.seatId, s.status]));
};

const freeSeats = async (showId: string, n: number) => {
  const map = await seatStatus(showId);
  const free = [...map.entries()].filter(([, s]) => s === 'AVAILABLE').map(([id]) => id);
  assert.ok(free.length >= n, 'not enough free seats');
  // pick from the back of the list to stay clear of seats a human may be clicking on
  return free.slice(-n - 5, -5).slice(0, n);
};

console.log('\nShowtime end-to-end test\n');

await step('all services are healthy', async () => {
  const r = await api('GET', '/health/services');
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

const alice = await register('alice');
const bob = await register('bob');
const { showId, movieTitle } = await findBookableShow();
console.log(`  · using show ${showId.slice(0, 8)} (${movieTitle})`);

// ── happy path ────────────────────────────────────────────────────────────────
let bookingId = '';
let paymentId = '';
const seats = await freeSeats(showId, 2);

await step('quote prices seats with a coupon', async () => {
  const r = await api('POST', '/api/bookings/quote', { token: alice.token, body: { showId, seatIds: seats, couponCode: 'FLAT100' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.discount, 100_00);
  assert.ok(r.body.total > 0);
});

await step('alice holds 2 seats (idempotent retry replays the same booking)', async () => {
  const key = newKey();
  const first = await api('POST', '/api/bookings/holds', { token: alice.token, idempotencyKey: key, body: { showId, seatIds: seats } });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const retry = await api('POST', '/api/bookings/holds', { token: alice.token, idempotencyKey: key, body: { showId, seatIds: seats } });
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.body.id, first.body.id);
  bookingId = first.body.id;
  assert.equal(first.body.status, 'PENDING');
});

await step('seat map shows HELD_BY_YOU for alice and HELD for bob', async () => {
  assert.equal((await seatStatus(showId, alice.token)).get(seats[0]!), 'HELD_BY_YOU');
  assert.equal((await seatStatus(showId, bob.token)).get(seats[0]!), 'HELD');
});

await step('bob cannot hold the same seats (409 with the conflicting seats)', async () => {
  const r = await api('POST', '/api/bookings/holds', { token: bob.token, body: { showId, seatIds: [seats[1]!] } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'SEATS_UNAVAILABLE');
  assert.deepEqual(r.body.error.details.seatIds, [seats[1]]);
});

await step('bob cannot read or pay for alice’s booking', async () => {
  assert.equal((await api('GET', `/api/bookings/${bookingId}`, { token: bob.token })).status, 404);
  const r = await api('POST', '/api/payments/intents', { token: bob.token, idempotencyKey: newKey(), body: { bookingId } });
  assert.equal(r.status, 404);
});

await step('payment intent: idempotency key required, retries return the same payment', async () => {
  assert.equal((await api('POST', '/api/payments/intents', { token: alice.token, body: { bookingId } })).status, 400);
  const key = newKey();
  const a = await api('POST', '/api/payments/intents', { token: alice.token, idempotencyKey: key, body: { bookingId } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await api('POST', '/api/payments/intents', { token: alice.token, idempotencyKey: key, body: { bookingId } });
  assert.equal(b.body.id, a.body.id);
  // A different key still resumes the one open payment instead of creating a second charge.
  const c = await api('POST', '/api/payments/intents', { token: alice.token, idempotencyKey: newKey(), body: { bookingId } });
  assert.equal(c.body.id, a.body.id);
  paymentId = a.body.id;
});

await step('successful payment confirms the booking via events (saga)', async () => {
  const r = await api('POST', `/api/payments/${paymentId}/mock/complete`, { token: alice.token, body: { outcome: 'success' } });
  assert.equal(r.body.status, 'SUCCEEDED', JSON.stringify(r.body));
  const booking = await waitFor('booking CONFIRMED', async () => {
    const b = await api('GET', `/api/bookings/${bookingId}`, { token: alice.token });
    return b.body.status === 'CONFIRMED' && b.body;
  });
  assert.equal(booking.paymentId, paymentId);
  assert.equal((await seatStatus(showId)).get(seats[0]!), 'BOOKED');
});

await step('paying twice is rejected', async () => {
  const r = await api('POST', `/api/payments/${paymentId}/mock/complete`, { token: alice.token, body: { outcome: 'success' } });
  assert.equal(r.status, 409);
});

await step('confirmation notification is delivered', async () => {
  await waitFor('notification', async () => {
    const n = await api('GET', '/api/notifications/me', { token: alice.token });
    return n.body.some((m: { title: string }) => m.title.includes(movieTitle));
  });
});

// ── failure path ──────────────────────────────────────────────────────────────
await step('failed payment fails the booking and releases the seats', async () => {
  const [seat] = await freeSeats(showId, 1);
  const hold = await api('POST', '/api/bookings/holds', { token: bob.token, body: { showId, seatIds: [seat!] } });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const pay = await api('POST', '/api/payments/intents', { token: bob.token, idempotencyKey: newKey(), body: { bookingId: hold.body.id } });
  await api('POST', `/api/payments/${pay.body.id}/mock/complete`, { token: bob.token, body: { outcome: 'failure' } });
  await waitFor('booking FAILED', async () => (await api('GET', `/api/bookings/${hold.body.id}`, { token: bob.token })).body.status === 'FAILED');
  assert.equal((await seatStatus(showId)).get(seat!), 'AVAILABLE');
});

// ── cancellation + refund (compensating transaction) ────────────────────────────
await step('cancelling a confirmed booking frees the seats and refunds the payment', async () => {
  const r = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: alice.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'CANCELLED');
  assert.equal((await seatStatus(showId)).get(seats[0]!), 'AVAILABLE');
  await waitFor('payment REFUNDED', async () => (await api('GET', `/api/payments/${paymentId}`, { token: alice.token })).body.status === 'REFUNDED');
});

await step('a cancelled booking cannot be cancelled again', async () => {
  const r = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: alice.token });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'INVALID_BOOKING_STATE');
});

// ── security & validation ─────────────────────────────────────────────────────
await step('forged identity headers are stripped by the gateway', async () => {
  const r = await api('GET', '/api/bookings/me', { headers: { 'x-user-id': alice.userId, 'x-user-role': 'ADMIN' } });
  assert.equal(r.status, 401);
});

await step('services reject calls that bypass the gateway', async () => {
  const r = await fetch(`${BOOKING_DIRECT}/bookings/me`, { headers: { 'x-user-id': alice.userId, 'x-user-role': 'USER' } }).catch(() => undefined);
  if (r) assert.equal(r.status, 403);
});

await step('invalid / tampered tokens are rejected', async () => {
  const r = await api('GET', '/api/bookings/me', { token: `${alice.token.slice(0, -4)}abcd` });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'INVALID_TOKEN');
});

await step('non-admins cannot use admin endpoints', async () => {
  assert.equal((await api('GET', '/api/bookings/admin/stats', { token: alice.token })).status, 403);
});

await step('input validation returns field-level errors', async () => {
  const r = await api('POST', '/api/bookings/holds', { token: alice.token, body: { showId, seatIds: [] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_FAILED');
});

await step('unknown coupons are rejected', async () => {
  const r = await api('POST', '/api/bookings/quote', { token: alice.token, body: { showId, seatIds: [seats[0]!], couponCode: 'FREEMOVIES' } });
  assert.equal(r.status, 422);
});

await step('refresh token rotation: old token is single-use, reuse kills the session', async () => {
  const login = await fetch(`http://${new URL(process.env.GATEWAY_URL ?? 'http://localhost:8080').host}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: alice.email, password: 'password123' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const r1 = await api('POST', '/api/auth/refresh', { headers: { cookie } });
  assert.equal(r1.status, 200);
  const rotated = r1.headers.get('set-cookie')!.split(';')[0]!;
  assert.notEqual(rotated, cookie);
  const reuse = await api('POST', '/api/auth/refresh', { headers: { cookie } }); // replay the old one
  assert.equal(reuse.status, 401);
  const afterReuse = await api('POST', '/api/auth/refresh', { headers: { cookie: rotated } }); // whole family revoked
  assert.equal(afterReuse.status, 401);
});

console.log(`\n\x1b[32m${passed} checks passed\x1b[0m\n`);
