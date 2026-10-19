import { describe, expect, it } from 'vitest';
import { localTime, PricingEngine, type PricedSeat } from './pricing.js';

const TZ = 'Asia/Kolkata';
const engine = PricingEngine.default(30_00);
// 2026-10-21 is a Wednesday, 2026-10-24 a Saturday.
const weekdayEvening = new Date('2026-10-21T19:00:00+05:30');
const weekdayMorning = new Date('2026-10-21T10:00:00+05:30');
const saturday = new Date('2026-10-24T19:00:00+05:30');

const seats = (...prices: [string, number][]): PricedSeat[] =>
  prices.map(([category, price], i) => ({ seatId: `A${i + 1}`, category: category as PricedSeat['category'], price }));

describe('PricingEngine', () => {
  it('groups tickets by category and adds fee + GST on the fee', () => {
    const p = engine.price({ seats: seats(['REGULAR', 180_00], ['REGULAR', 180_00], ['PREMIUM', 260_00]), showStartsAt: weekdayEvening, timezone: TZ });
    expect(p.items.filter((i) => i.kind === 'TICKET').map((i) => [i.label, i.amount])).toEqual([
      ['2 × Regular', 360_00],
      ['1 × Premium', 260_00],
    ]);
    expect(p.ticketTotal).toBe(620_00);
    expect(p.fees).toBe(90_00); // 3 × ₹30
    expect(p.taxes).toBe(16_20); // 18% of ₹90
    expect(p.total).toBe(620_00 + 90_00 + 16_20);
  });

  it('adds a 10% weekend surcharge based on venue local time', () => {
    const p = engine.price({ seats: seats(['REGULAR', 200_00]), showStartsAt: saturday, timezone: TZ });
    expect(p.items.find((i) => i.code === 'WEEKEND')?.amount).toBe(20_00);
    expect(p.ticketTotal).toBe(220_00);
  });

  it('uses the venue timezone, not UTC, to decide the day', () => {
    // Friday 23:30 UTC is already Saturday morning in India.
    expect(localTime(new Date('2026-10-23T23:30:00Z'), TZ)).toEqual({ weekday: 6, hour: 5 });
  });

  it('FIRST50 takes 50% off tickets, capped at ₹150', () => {
    const p = engine.price({ seats: seats(['RECLINER', 450_00]), showStartsAt: weekdayEvening, timezone: TZ, couponCode: 'first50' });
    expect(p.discount).toBe(150_00);
    expect(p.total).toBe(450_00 - 150_00 + 30_00 + 5_40);
  });

  it('FLAT100 requires two seats', () => {
    expect(() => engine.price({ seats: seats(['REGULAR', 180_00]), showStartsAt: weekdayEvening, timezone: TZ, couponCode: 'FLAT100' })).toThrow(/at least 2/);
    const p = engine.price({ seats: seats(['REGULAR', 180_00], ['REGULAR', 180_00]), showStartsAt: weekdayEvening, timezone: TZ, couponCode: 'FLAT100' });
    expect(p.discount).toBe(100_00);
  });

  it('MATINEE20 only works before noon', () => {
    expect(engine.price({ seats: seats(['REGULAR', 100_00]), showStartsAt: weekdayMorning, timezone: TZ, couponCode: 'MATINEE20' }).discount).toBe(20_00);
    expect(() => engine.price({ seats: seats(['REGULAR', 100_00]), showStartsAt: weekdayEvening, timezone: TZ, couponCode: 'MATINEE20' })).toThrow(/before 12/);
  });

  it('rejects unknown coupons', () => {
    expect(() => engine.price({ seats: seats(['REGULAR', 100_00]), showStartsAt: weekdayEvening, timezone: TZ, couponCode: 'NOPE' })).toThrow(/does not exist/);
  });

  it('never discounts more than the ticket value', () => {
    const p = new PricingEngine([]).price({ seats: [], showStartsAt: weekdayEvening, timezone: TZ });
    expect(p.total).toBe(0);
  });

  it('all amounts are integers (paise)', () => {
    const p = engine.price({ seats: seats(['REGULAR', 333_33], ['PREMIUM', 111_11]), showStartsAt: saturday, timezone: TZ, couponCode: 'FIRST50' });
    for (const i of p.items) expect(Number.isInteger(i.amount)).toBe(true);
  });
});
