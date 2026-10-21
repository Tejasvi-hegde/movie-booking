/**
 * Event contracts shared by all services. Each topic maps to one Redis Stream.
 * Events are facts in past tense; consumers must be idempotent because delivery is at-least-once.
 */

export const TOPICS = {
  catalog: 'catalog.events',
  booking: 'booking.events',
  payment: 'payment.events',
};

/**
 * Every event travels in the same envelope:
 *
 * @typedef {object} EventEnvelope
 * @property {string} id          unique per event; consumers use it for de-duplication
 * @property {string} type        e.g. 'booking.confirmed'
 * @property {string} source      the service that published it
 * @property {string} occurredAt  ISO timestamp
 * @property {1} version
 * @property {object} data        the payload, shapes below
 *
 * Payloads (amounts in paise):
 *   show.created       { showId, movieId, movieTitle, venueId, venueName, city, screenId, screenName, startsAt, timezone,
 *                        seats: [{ seatId, row, number, category, price }] }
 *   show.cancelled     { showId, reason }
 *   booking.confirmed  { bookingId, userId, userEmail, userName, showId, paymentId, amount, currency, seats,
 *                        movieTitle, venueName, screenName, startsAt }
 *   booking.failed     { bookingId, userId, userEmail, userName, showId, reason, paymentId?, refundRequired }
 *                        refundRequired: money was captured but the booking can't be honoured, so payment must refund it
 *   booking.expired    { bookingId, userId, userEmail, userName, showId, seats }
 *   booking.cancelled  { bookingId, userId, userEmail, userName, showId, reason, paymentId?, refundRequired, amount, seats, movieTitle }
 *   payment.succeeded  { paymentId, bookingId, userId, amount, provider }
 *   payment.failed     { paymentId, bookingId, userId, reason }
 *   payment.refunded   { paymentId, bookingId, userId, userEmail?, amount, reason }
 */

/** Which stream each event type is published to. */
export const EVENT_TOPIC = {
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
