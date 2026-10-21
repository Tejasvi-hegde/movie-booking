import { describe, expect, it } from 'vitest';
import { Booking } from './booking.js';
import { InvalidStateTransitionError } from './booking-state.js';

const HOUR = 3_600_000;
const now = new Date('2026-10-20T10:00:00Z');

function makeBooking(overrides = {}) {
  return new Booking({
    id: 'b1',
    userId: 'u1',
    userEmail: 'u@x.dev',
    userName: 'U',
    showId: 's1',
    status: 'PENDING',
    seatIds: ['A1', 'A2'],
    amount: 50_000,
    currency: 'INR',
    priceBreakdown: { items: [], ticketTotal: 0, discount: 0, fees: 0, taxes: 0, total: 50_000, currency: 'INR' },
    couponCode: null,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    paymentId: null,
    statusReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    cancelledAt: null,
    ...overrides,
  });
}

const cancelCtx = (showStartsAt, force = false) => ({ now, showStartsAt, cutoffMs: 2 * HOUR, force });

describe('Booking state machine', () => {
  it('PENDING → CONFIRMED records the payment', () => {
    const b = makeBooking();
    b.confirm('pay-1', now);
    expect(b.status).toBe('CONFIRMED');
    expect(b.paymentId).toBe('pay-1');
    expect(b.snapshot().confirmedAt).toEqual(now);
    expect(b.isDirty).toBe(true);
  });

  it('PENDING → FAILED keeps the reason', () => {
    const b = makeBooking();
    b.fail('card declined');
    expect(b.status).toBe('FAILED');
    expect(b.snapshot().statusReason).toBe('card declined');
  });

  it('cannot expire before the deadline', () => {
    const b = makeBooking();
    expect(() => b.expire(now)).toThrow(/not expired/);
    b.expire(new Date(now.getTime() + 5 * 60_000));
    expect(b.status).toBe('EXPIRED');
  });

  it('cancelling a pending hold needs no refund', () => {
    const b = makeBooking();
    expect(b.cancel(cancelCtx(new Date(now.getTime() + 30 * 60_000)))).toEqual({ refundRequired: false });
    expect(b.status).toBe('CANCELLED');
  });

  it('cancelling a confirmed booking refunds, but only before the cut-off', () => {
    const early = makeBooking({ status: 'CONFIRMED', paymentId: 'p' });
    expect(early.cancel(cancelCtx(new Date(now.getTime() + 3 * HOUR)))).toEqual({ refundRequired: true });

    const late = makeBooking({ status: 'CONFIRMED', paymentId: 'p' });
    expect(() => late.cancel(cancelCtx(new Date(now.getTime() + HOUR)))).toThrow(/2 hours before/);
    expect(late.status).toBe('CONFIRMED');
  });

  it('venue cancellations ignore the cut-off', () => {
    const b = makeBooking({ status: 'CONFIRMED', paymentId: 'p' });
    expect(b.cancel(cancelCtx(new Date(now.getTime() + 10 * 60_000), true))).toEqual({ refundRequired: true });
    expect(b.snapshot().statusReason).toMatch(/venue/);
  });

  it.each(['FAILED', 'EXPIRED', 'CANCELLED'])('%s is terminal', (status) => {
    const b = makeBooking({ status });
    expect(() => b.confirm('p', now)).toThrow(InvalidStateTransitionError);
    expect(() => b.fail('x')).toThrow(InvalidStateTransitionError);
    expect(() => b.expire(new Date(now.getTime() + HOUR))).toThrow(InvalidStateTransitionError);
    expect(() => b.cancel(cancelCtx(new Date(now.getTime() + 5 * HOUR)))).toThrow(InvalidStateTransitionError);
    expect(b.isDirty).toBe(false);
  });

  it('a confirmed booking cannot be confirmed twice', () => {
    const b = makeBooking({ status: 'CONFIRMED', paymentId: 'p1' });
    expect(() => b.confirm('p2', now)).toThrow(/Cannot confirm a confirmed booking/);
  });

  it('only pending bookings with time left are payable', () => {
    expect(() => makeBooking().assertPayable(now)).not.toThrow();
    expect(() => makeBooking({ expiresAt: new Date(now.getTime() + 5_000) }).assertPayable(now)).toThrow(/expired/);
    expect(() => makeBooking({ status: 'CONFIRMED' }).assertPayable(now)).toThrow(/cannot be paid/);
  });
});
