import { UnprocessableError } from '@showtime/common';

/**
 * All amounts are integer paise (₹1 = 100). Never use floats for money.
 *
 * @typedef {{ seatId: string, category: 'REGULAR' | 'PREMIUM' | 'RECLINER', price: number }} PricedSeat
 * @typedef {{ seats: PricedSeat[], showStartsAt: Date, timezone: string, couponCode?: string }} PricingContext
 * @typedef {{ kind: 'TICKET' | 'SURCHARGE' | 'DISCOUNT' | 'FEE' | 'TAX', code: string, label: string, amount: number }} LineItem
 *   (amount is negative for discounts)
 * @typedef {{ items: LineItem[], ticketTotal: number, discount: number, fees: number, taxes: number, total: number, currency: 'INR' }} PriceBreakdown
 */

const CATEGORY_LABEL = { REGULAR: 'Regular', PREMIUM: 'Premium', RECLINER: 'Recliner' };

/**
 * Strategy pattern: every pricing concern is a separate rule. The engine runs them in order,
 * each one seeing the line items produced so far. New pricing ideas (student discount,
 * dynamic pricing for blockbuster shows) are new classes — no existing rule changes.
 *
 * A rule is any object with `name` and `apply(ctx, itemsSoFar)` returning the LineItems it adds.
 * Coupons follow the same idea: each has `code`, `description` and `discount(ctx, ticketTotal)`,
 * which returns the discount in paise or throws if the booking is not eligible.
 */

const sum = (items, kinds) => items.filter((i) => kinds.includes(i.kind)).reduce((acc, i) => acc + i.amount, 0);

/** Day of week and hour of the show *at the venue*, not on the server. */
export function localTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(
    date,
  );
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

export class SeatPriceRule {
  name = 'seat-price';
  apply(ctx) {
    const byCategory = new Map();
    for (const seat of ctx.seats) byCategory.set(seat.category, [...(byCategory.get(seat.category) ?? []), seat]);
    return [...byCategory.entries()].map(([category, seats]) => ({
      kind: 'TICKET',
      code: `TICKET_${category}`,
      label: `${seats.length} × ${CATEGORY_LABEL[category]}`,
      amount: seats.reduce((a, s) => a + s.price, 0),
    }));
  }
}

export class WeekendSurchargeRule {
  name = 'weekend-surcharge';
  constructor(percent = 10) {
    this.percent = percent;
  }
  apply(ctx, items) {
    const { weekday } = localTime(ctx.showStartsAt, ctx.timezone);
    if (![0, 5, 6].includes(weekday)) return []; // Fri, Sat, Sun
    const amount = Math.round((sum(items, ['TICKET']) * this.percent) / 100);
    return amount ? [{ kind: 'SURCHARGE', code: 'WEEKEND', label: `Weekend surcharge (${this.percent}%)`, amount }] : [];
  }
}

// ── coupons (another Strategy family) ─────────────────────────────────────────

class PercentOffCoupon {
  constructor(code, description, percent, cap) {
    this.code = code;
    this.description = description;
    this.percent = percent;
    this.cap = cap;
  }
  discount(_ctx, ticketTotal) {
    return Math.min(Math.round((ticketTotal * this.percent) / 100), this.cap);
  }
}

class FlatOffCoupon {
  constructor(code, description, amount, minSeats) {
    this.code = code;
    this.description = description;
    this.amount = amount;
    this.minSeats = minSeats;
  }
  discount(ctx, ticketTotal) {
    if (ctx.seats.length < this.minSeats)
      throw new UnprocessableError('COUPON_NOT_APPLICABLE', `${this.code} needs at least ${this.minSeats} seats`);
    return Math.min(this.amount, ticketTotal);
  }
}

class MatineeCoupon {
  constructor(code, description, percent, beforeHour) {
    this.code = code;
    this.description = description;
    this.percent = percent;
    this.beforeHour = beforeHour;
  }
  discount(ctx, ticketTotal) {
    if (localTime(ctx.showStartsAt, ctx.timezone).hour >= this.beforeHour) {
      throw new UnprocessableError('COUPON_NOT_APPLICABLE', `${this.code} is valid only for shows before ${this.beforeHour}:00`);
    }
    return Math.round((ticketTotal * this.percent) / 100);
  }
}

export const COUPONS = [
  new PercentOffCoupon('FIRST50', '50% off tickets, up to ₹150', 50, 150_00),
  new FlatOffCoupon('FLAT100', '₹100 off when you book 2 or more seats', 100_00, 2),
  new MatineeCoupon('MATINEE20', '20% off shows starting before noon', 20, 12),
];

export class CouponRule {
  name = 'coupon';
  constructor(coupons = COUPONS) {
    this.coupons = new Map(coupons.map((c) => [c.code, c]));
  }
  apply(ctx, items) {
    if (!ctx.couponCode) return [];
    const coupon = this.coupons.get(ctx.couponCode.trim().toUpperCase());
    if (!coupon) throw new UnprocessableError('INVALID_COUPON', `Coupon ${ctx.couponCode} does not exist`);
    const discountable = sum(items, ['TICKET', 'SURCHARGE']);
    const amount = Math.min(coupon.discount(ctx, discountable), discountable);
    return amount ? [{ kind: 'DISCOUNT', code: coupon.code, label: `Coupon ${coupon.code}`, amount: -amount }] : [];
  }
}

export class ConvenienceFeeRule {
  name = 'convenience-fee';
  constructor(perTicket, gstPercent = 18) {
    this.perTicket = perTicket;
    this.gstPercent = gstPercent;
  }
  apply(ctx) {
    const fee = this.perTicket * ctx.seats.length;
    if (!fee) return [];
    return [
      { kind: 'FEE', code: 'CONVENIENCE_FEE', label: 'Convenience fee', amount: fee },
      { kind: 'TAX', code: 'GST', label: `GST on fee (${this.gstPercent}%)`, amount: Math.round((fee * this.gstPercent) / 100) },
    ];
  }
}

export class PricingEngine {
  constructor(rules) {
    this.rules = rules;
  }

  static default(convenienceFeePerTicket) {
    return new PricingEngine([
      new SeatPriceRule(),
      new WeekendSurchargeRule(10),
      new CouponRule(),
      new ConvenienceFeeRule(convenienceFeePerTicket),
    ]);
  }

  price(ctx) {
    const items = [];
    for (const rule of this.rules) items.push(...rule.apply(ctx, items));
    const ticketTotal = sum(items, ['TICKET', 'SURCHARGE']);
    const discount = -sum(items, ['DISCOUNT']);
    const fees = sum(items, ['FEE']);
    const taxes = sum(items, ['TAX']);
    return { items, ticketTotal, discount, fees, taxes, total: Math.max(0, ticketTotal - discount + fees + taxes), currency: 'INR' };
  }
}
