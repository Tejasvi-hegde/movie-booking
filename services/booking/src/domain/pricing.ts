import { UnprocessableError, type SeatCategory } from '@showtime/common';

/** All amounts are integer paise (₹1 = 100). Never use floats for money. */
export interface PricedSeat {
  seatId: string;
  category: SeatCategory;
  price: number;
}

export interface PricingContext {
  seats: PricedSeat[];
  showStartsAt: Date;
  timezone: string;
  couponCode?: string;
}

export type LineItemKind = 'TICKET' | 'SURCHARGE' | 'DISCOUNT' | 'FEE' | 'TAX';

export interface LineItem {
  kind: LineItemKind;
  code: string;
  label: string;
  /** Negative for discounts. */
  amount: number;
}

export interface PriceBreakdown {
  items: LineItem[];
  ticketTotal: number;
  discount: number;
  fees: number;
  taxes: number;
  total: number;
  currency: 'INR';
}

const CATEGORY_LABEL: Record<SeatCategory, string> = { REGULAR: 'Regular', PREMIUM: 'Premium', RECLINER: 'Recliner' };

/**
 * Strategy pattern: every pricing concern is a separate rule. The engine runs them in order,
 * each one seeing the line items produced so far. New pricing ideas (student discount,
 * dynamic pricing for blockbuster shows) are new classes — no existing rule changes.
 */
export interface PricingRule {
  readonly name: string;
  apply(ctx: PricingContext, itemsSoFar: readonly LineItem[]): LineItem[];
}

const sum = (items: readonly LineItem[], kinds: LineItemKind[]) =>
  items.filter((i) => kinds.includes(i.kind)).reduce((acc, i) => acc + i.amount, 0);

/** Day of week and hour of the show *at the venue*, not on the server. */
export function localTime(date: Date, timezone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

export class SeatPriceRule implements PricingRule {
  readonly name = 'seat-price';
  apply(ctx: PricingContext): LineItem[] {
    const byCategory = new Map<SeatCategory, PricedSeat[]>();
    for (const seat of ctx.seats) byCategory.set(seat.category, [...(byCategory.get(seat.category) ?? []), seat]);
    return [...byCategory.entries()].map(([category, seats]) => ({
      kind: 'TICKET',
      code: `TICKET_${category}`,
      label: `${seats.length} × ${CATEGORY_LABEL[category]}`,
      amount: seats.reduce((a, s) => a + s.price, 0),
    }));
  }
}

export class WeekendSurchargeRule implements PricingRule {
  readonly name = 'weekend-surcharge';
  constructor(private readonly percent = 10) {}
  apply(ctx: PricingContext, items: readonly LineItem[]): LineItem[] {
    const { weekday } = localTime(ctx.showStartsAt, ctx.timezone);
    if (![0, 5, 6].includes(weekday)) return []; // Fri, Sat, Sun
    const amount = Math.round((sum(items, ['TICKET']) * this.percent) / 100);
    return amount ? [{ kind: 'SURCHARGE', code: 'WEEKEND', label: `Weekend surcharge (${this.percent}%)`, amount }] : [];
  }
}

// ── coupons (another Strategy family) ─────────────────────────────────────────

export interface Coupon {
  readonly code: string;
  readonly description: string;
  /** Returns the discount in paise (positive), or throws if the booking is not eligible. */
  discount(ctx: PricingContext, ticketTotal: number): number;
}

class PercentOffCoupon implements Coupon {
  constructor(readonly code: string, readonly description: string, private readonly percent: number, private readonly cap: number) {}
  discount(_ctx: PricingContext, ticketTotal: number): number {
    return Math.min(Math.round((ticketTotal * this.percent) / 100), this.cap);
  }
}

class FlatOffCoupon implements Coupon {
  constructor(readonly code: string, readonly description: string, private readonly amount: number, private readonly minSeats: number) {}
  discount(ctx: PricingContext, ticketTotal: number): number {
    if (ctx.seats.length < this.minSeats) throw new UnprocessableError('COUPON_NOT_APPLICABLE', `${this.code} needs at least ${this.minSeats} seats`);
    return Math.min(this.amount, ticketTotal);
  }
}

class MatineeCoupon implements Coupon {
  constructor(readonly code: string, readonly description: string, private readonly percent: number, private readonly beforeHour: number) {}
  discount(ctx: PricingContext, ticketTotal: number): number {
    if (localTime(ctx.showStartsAt, ctx.timezone).hour >= this.beforeHour) {
      throw new UnprocessableError('COUPON_NOT_APPLICABLE', `${this.code} is valid only for shows before ${this.beforeHour}:00`);
    }
    return Math.round((ticketTotal * this.percent) / 100);
  }
}

export const COUPONS: Coupon[] = [
  new PercentOffCoupon('FIRST50', '50% off tickets, up to ₹150', 50, 150_00),
  new FlatOffCoupon('FLAT100', '₹100 off when you book 2 or more seats', 100_00, 2),
  new MatineeCoupon('MATINEE20', '20% off shows starting before noon', 20, 12),
];

export class CouponRule implements PricingRule {
  readonly name = 'coupon';
  private readonly coupons: Map<string, Coupon>;
  constructor(coupons: Coupon[] = COUPONS) {
    this.coupons = new Map(coupons.map((c) => [c.code, c]));
  }
  apply(ctx: PricingContext, items: readonly LineItem[]): LineItem[] {
    if (!ctx.couponCode) return [];
    const coupon = this.coupons.get(ctx.couponCode.trim().toUpperCase());
    if (!coupon) throw new UnprocessableError('INVALID_COUPON', `Coupon ${ctx.couponCode} does not exist`);
    const discountable = sum(items, ['TICKET', 'SURCHARGE']);
    const amount = Math.min(coupon.discount(ctx, discountable), discountable);
    return amount ? [{ kind: 'DISCOUNT', code: coupon.code, label: `Coupon ${coupon.code}`, amount: -amount }] : [];
  }
}

export class ConvenienceFeeRule implements PricingRule {
  readonly name = 'convenience-fee';
  constructor(private readonly perTicket: number, private readonly gstPercent = 18) {}
  apply(ctx: PricingContext): LineItem[] {
    const fee = this.perTicket * ctx.seats.length;
    if (!fee) return [];
    return [
      { kind: 'FEE', code: 'CONVENIENCE_FEE', label: 'Convenience fee', amount: fee },
      { kind: 'TAX', code: 'GST', label: `GST on fee (${this.gstPercent}%)`, amount: Math.round((fee * this.gstPercent) / 100) },
    ];
  }
}

export class PricingEngine {
  constructor(private readonly rules: PricingRule[]) {}

  static default(convenienceFeePerTicket: number): PricingEngine {
    return new PricingEngine([new SeatPriceRule(), new WeekendSurchargeRule(10), new CouponRule(), new ConvenienceFeeRule(convenienceFeePerTicket)]);
  }

  price(ctx: PricingContext): PriceBreakdown {
    const items: LineItem[] = [];
    for (const rule of this.rules) items.push(...rule.apply(ctx, items));
    const ticketTotal = sum(items, ['TICKET', 'SURCHARGE']);
    const discount = -sum(items, ['DISCOUNT']);
    const fees = sum(items, ['FEE']);
    const taxes = sum(items, ['TAX']);
    return { items, ticketTotal, discount, fees, taxes, total: Math.max(0, ticketTotal - discount + fees + taxes), currency: 'INR' };
  }
}
