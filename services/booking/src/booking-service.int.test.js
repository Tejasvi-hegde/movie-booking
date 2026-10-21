/**
 * Integration tests: real Postgres + Redis (see README → Running tests).
 *   TEST_DATABASE_URL (default postgres://postgres:postgres@localhost:5432/showtime_booking_test)
 *   TEST_REDIS_URL    (default redis://localhost:6379/15)
 * Each integration test file uses its own Redis database, because each one calls flushdb().
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger, createPool, ensureDatabase, Redis, runMigrations } from '@showtime/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BookingService } from './booking-service.js';
import { PricingEngine } from './domain/pricing.js';
import { SeatLockManager } from './seat-lock.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/showtime_booking_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const logger = createLogger('test', 'silent');

let pool;
let redis;
let locks;
let service;
const settings = { holdTtlMs: 60_000, holdGraceMs: 10_000, maxSeatsPerBooking: 10, cancellationCutoffMs: 2 * 3_600_000 };

const user = (n = 0) => ({ id: `user-${n}-${randomUUID().slice(0, 6)}`, role: 'USER', email: `u${n}@test.dev`, name: `User ${n}` });

async function createShow(startsInHours = 24) {
  const showId = randomUUID();
  const seats = ['A', 'B'].flatMap((row) =>
    Array.from({ length: 10 }, (_, i) => ({ seatId: `${row}${i + 1}`, row, number: i + 1, category: 'REGULAR', price: 200_00 })),
  );
  const data = {
    showId,
    movieId: 'm1',
    movieTitle: 'Test Film',
    venueId: 'v1',
    venueName: 'Test Venue',
    city: 'Bengaluru',
    screenId: 's1',
    screenName: 'Audi 1',
    startsAt: new Date(Date.now() + startsInHours * 3_600_000).toISOString(),
    timezone: 'Asia/Kolkata',
    seats,
  };
  await service.onShowCreated(data);
  await service.onShowCreated(data); // duplicate delivery must be harmless
  return showId;
}

const outboxTypes = async (bookingId) =>
  (await pool.query(`SELECT type, payload FROM outbox WHERE payload->'data'->>'bookingId' = $1 ORDER BY seq`, [bookingId])).rows;

beforeAll(async () => {
  await ensureDatabase(DB_URL);
  pool = createPool(DB_URL, 40);
  await runMigrations(pool, fileURLToPath(new URL('../migrations', import.meta.url)), logger);
  // Start from empty tables: rows left by earlier runs (e.g. unpaid holds) would otherwise
  // change what the expiry sweeper picks up and make results depend on run history.
  await pool.query('TRUNCATE bookings, show_seats, shows, outbox, idempotency_keys');
  redis = new Redis(REDIS_URL);
  locks = new SeatLockManager(redis);
  service = new BookingService(
    pool,
    locks,
    PricingEngine.default(30_00),
    { notify: () => undefined },
    { kick: () => undefined },
    settings,
    logger,
  );
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await pool?.end();
  await redis?.quit();
});

describe('show inventory', () => {
  it('creates seats once even if show.created is delivered twice', async () => {
    const showId = await createShow();
    const map = await service.seatMap(showId);
    expect(map.seats).toHaveLength(20);
    expect(map.seats.every((s) => s.status === 'AVAILABLE')).toBe(true);
  });
});

describe('holding seats', () => {
  it('lets exactly one of 50 concurrent users hold the same seat', async () => {
    const showId = await createShow();
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => service.hold(user(i), { showId, seatIds: ['A5'] })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected' && r.reason.code === 'SEATS_UNAVAILABLE');
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(49);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM bookings WHERE show_id = $1 AND status = 'PENDING'`, [showId]);
    expect(rows[0].n).toBe(1);
  });

  it('is all-or-nothing: an overlapping request locks none of its seats', async () => {
    const showId = await createShow();
    await service.hold(user(1), { showId, seatIds: ['A1', 'A2'] });
    await expect(service.hold(user(2), { showId, seatIds: ['A2', 'A3'] })).rejects.toMatchObject({
      code: 'SEATS_UNAVAILABLE',
      details: { seatIds: ['A2'] },
    });
    // A3 must not have been left locked by the failed attempt
    await expect(service.hold(user(3), { showId, seatIds: ['A3'] })).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('replaces a user’s earlier hold for the same show', async () => {
    const showId = await createShow();
    const u = user();
    const first = await service.hold(u, { showId, seatIds: ['B1'] });
    const second = await service.hold(u, { showId, seatIds: ['B2'] });
    expect((await service.getForUser(u, first.id)).status).toBe('CANCELLED');
    expect(second.status).toBe('PENDING');
    // B1 is free again for others
    await expect(service.hold(user(9), { showId, seatIds: ['B1'] })).resolves.toBeTruthy();
  });

  it('rejects unknown seats and too many seats', async () => {
    const showId = await createShow();
    await expect(service.hold(user(), { showId, seatIds: ['Z9'] })).rejects.toMatchObject({ status: 400 });
    await expect(service.hold(user(), { showId, seatIds: Array.from({ length: 11 }, (_, i) => `A${i + 1}`) })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('payment saga', () => {
  it('confirms on payment.succeeded and is idempotent on redelivery', async () => {
    const showId = await createShow();
    const u = user();
    const b = await service.hold(u, { showId, seatIds: ['A7', 'A8'] });
    const event = { paymentId: randomUUID(), bookingId: b.id, userId: u.id, amount: b.amount, provider: 'mock' };
    await service.onPaymentSucceeded(event);
    await service.onPaymentSucceeded(event);

    expect((await service.getForUser(u, b.id)).status).toBe('CONFIRMED');
    const seats = (await service.seatMap(showId)).seats.filter((s) => s.status === 'BOOKED').map((s) => s.seatId);
    expect(seats).toEqual(['A7', 'A8']);
    expect((await outboxTypes(b.id)).map((e) => e.type)).toEqual(['booking.confirmed']); // once, not twice
    expect(await redis.exists(SeatLockManager.key(showId, 'A7'))).toBe(0); // temporary lock released
  });

  it('a late payment for an expired booking is refunded, never double-books', async () => {
    const showId = await createShow();
    const u = user();
    const b = await service.hold(u, { showId, seatIds: ['B5'] });
    await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [b.id]);
    expect(await service.expireDue()).toBeGreaterThanOrEqual(1);

    const other = await service.hold(user(2), { showId, seatIds: ['B5'] }); // someone else takes the seat
    await service.onPaymentSucceeded({ paymentId: randomUUID(), bookingId: b.id, userId: u.id, amount: b.amount, provider: 'mock' });

    expect((await service.getForUser(u, b.id)).status).toBe('EXPIRED');
    const events = await outboxTypes(b.id);
    expect(events.map((e) => e.type)).toEqual(['booking.expired', 'booking.failed']);
    expect(events[1].payload.data.refundRequired).toBe(true);
    // The seat still belongs to the second user's hold — the late payment did not steal it.
    const b5 = (await service.seatMap(showId)).seats.find((s) => s.seatId === 'B5');
    expect(b5?.status).toBe('HELD');
    expect(await redis.get(SeatLockManager.key(showId, 'B5'))).toBe(other.id);
  });

  it('payment.failed fails the booking and frees the seats', async () => {
    const showId = await createShow();
    const u = user();
    const b = await service.hold(u, { showId, seatIds: ['A10'] });
    await service.onPaymentFailed({ paymentId: randomUUID(), bookingId: b.id, userId: u.id, reason: 'declined' });
    expect((await service.getForUser(u, b.id)).status).toBe('FAILED');
    await expect(service.hold(user(5), { showId, seatIds: ['A10'] })).resolves.toBeTruthy();
  });
});

describe('cancellation', () => {
  it('cancelling a confirmed booking frees seats and requests a refund', async () => {
    const showId = await createShow(5);
    const u = user();
    const b = await service.hold(u, { showId, seatIds: ['B9'] });
    const paymentId = randomUUID();
    await service.onPaymentSucceeded({ paymentId, bookingId: b.id, userId: u.id, amount: b.amount, provider: 'mock' });
    const cancelled = await service.cancel(u, b.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect((await service.seatMap(showId)).seats.find((s) => s.seatId === 'B9')?.status).toBe('AVAILABLE');
    const last = (await outboxTypes(b.id)).at(-1);
    expect(last.type).toBe('booking.cancelled');
    expect(last.payload.data).toMatchObject({ refundRequired: true, paymentId });
  });

  it('refuses to cancel within 2 hours of the show', async () => {
    const showId = await createShow(1);
    const u = user();
    const b = await service.hold(u, { showId, seatIds: ['A1'] });
    await service.onPaymentSucceeded({ paymentId: randomUUID(), bookingId: b.id, userId: u.id, amount: b.amount, provider: 'mock' });
    await expect(service.cancel(u, b.id)).rejects.toMatchObject({ code: 'CANCELLATION_WINDOW_CLOSED' });
  });

  it('a cancelled show cancels and refunds every confirmed booking', async () => {
    const showId = await createShow(1);
    const users = [user(1), user(2)];
    const bookings = await Promise.all(users.map((u, i) => service.hold(u, { showId, seatIds: [`A${i + 1}`] })));
    for (const [i, b] of bookings.entries()) {
      await service.onPaymentSucceeded({
        paymentId: randomUUID(),
        bookingId: b.id,
        userId: users[i].id,
        amount: b.amount,
        provider: 'mock',
      });
    }
    await service.onShowCancelled({ showId, reason: 'Projector failure' });
    for (const [i, b] of bookings.entries()) expect((await service.getForUser(users[i], b.id)).status).toBe('CANCELLED');
    await expect(service.hold(user(7), { showId, seatIds: ['A3'] })).rejects.toMatchObject({ code: 'SHOW_CANCELLED' });
  });
});
