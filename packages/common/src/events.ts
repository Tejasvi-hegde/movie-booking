/**
 * Event contracts shared by all services. Each topic maps to one Redis Stream.
 * Events are facts in past tense; consumers must be idempotent because delivery is at-least-once.
 */

export const TOPICS = {
  catalog: 'catalog.events',
  booking: 'booking.events',
  payment: 'payment.events',
} as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface EventEnvelope<TType extends string = string, TData = unknown> {
  /** Unique per event; consumers use it for de-duplication. */
  id: string;
  type: TType;
  source: string;
  occurredAt: string;
  version: 1;
  data: TData;
}

export type SeatCategory = 'REGULAR' | 'PREMIUM' | 'RECLINER';

export interface SeatDefinition {
  seatId: string;
  row: string;
  number: number;
  category: SeatCategory;
  /** In paise. */
  price: number;
}

// ── catalog ─────────────────────────────────────────────────────────────────────
export interface ShowCreatedData {
  showId: string;
  movieId: string;
  movieTitle: string;
  venueId: string;
  venueName: string;
  city: string;
  screenId: string;
  screenName: string;
  startsAt: string;
  timezone: string;
  seats: SeatDefinition[];
}
export interface ShowCancelledData {
  showId: string;
  reason: string;
}

// ── booking ─────────────────────────────────────────────────────────────────────
interface BookingRef {
  bookingId: string;
  userId: string;
  userEmail: string;
  userName: string;
  showId: string;
}
export interface BookingConfirmedData extends BookingRef {
  paymentId: string;
  amount: number;
  currency: string;
  seats: string[];
  movieTitle: string;
  venueName: string;
  screenName: string;
  startsAt: string;
}
export interface BookingFailedData extends BookingRef {
  reason: string;
  /** Set when money was captured but the booking could not be honoured — payment must refund it. */
  paymentId?: string;
  refundRequired: boolean;
}
export interface BookingExpiredData extends BookingRef {
  seats: string[];
}
export interface BookingCancelledData extends BookingRef {
  reason: string;
  paymentId?: string;
  refundRequired: boolean;
  amount: number;
  seats: string[];
  movieTitle: string;
}

// ── payment ─────────────────────────────────────────────────────────────────────
export interface PaymentSucceededData {
  paymentId: string;
  bookingId: string;
  userId: string;
  amount: number;
  provider: string;
}
export interface PaymentFailedData {
  paymentId: string;
  bookingId: string;
  userId: string;
  reason: string;
}
export interface PaymentRefundedData {
  paymentId: string;
  bookingId: string;
  userId: string;
  userEmail?: string;
  amount: number;
  reason: string;
}

export interface EventMap {
  'show.created': ShowCreatedData;
  'show.cancelled': ShowCancelledData;
  'booking.confirmed': BookingConfirmedData;
  'booking.failed': BookingFailedData;
  'booking.expired': BookingExpiredData;
  'booking.cancelled': BookingCancelledData;
  'payment.succeeded': PaymentSucceededData;
  'payment.failed': PaymentFailedData;
  'payment.refunded': PaymentRefundedData;
}
export type EventType = keyof EventMap;

export const EVENT_TOPIC: Record<EventType, Topic> = {
  'show.created': TOPICS.catalog,
  'show.cancelled': TOPICS.catalog,
  'booking.confirmed': TOPICS.booking,
  'booking.failed': TOPICS.booking,
  'booking.expired': TOPICS.booking,
  'booking.cancelled': TOPICS.booking,
  'payment.succeeded': TOPICS.payment,
  'payment.failed': TOPICS.payment,
  'payment.refunded': TOPICS.payment,
};

export type AnyEvent = { [K in EventType]: EventEnvelope<K, EventMap[K]> }[EventType];
