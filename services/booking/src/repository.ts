import type { Queryable, SeatCategory, SeatDefinition, ShowCreatedData } from '@showtime/common';
import { Booking, type BookingProps } from './domain/booking.js';
import type { BookingStatus } from './domain/booking-state.js';
import type { PriceBreakdown } from './domain/pricing.js';

export interface ShowRow {
  showId: string;
  movieTitle: string;
  venueName: string;
  city: string;
  screenName: string;
  startsAt: Date;
  timezone: string;
  status: 'SCHEDULED' | 'CANCELLED';
}

export interface SeatRow {
  seatId: string;
  row: string;
  number: number;
  category: SeatCategory;
  price: number;
  status: 'AVAILABLE' | 'BOOKED';
  bookingId: string | null;
}

interface BookingRow {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  show_id: string;
  status: BookingStatus;
  seat_ids: string[];
  amount: number;
  currency: string;
  price_breakdown: PriceBreakdown;
  coupon_code: string | null;
  expires_at: Date;
  payment_id: string | null;
  status_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
}

const toBooking = (r: BookingRow) =>
  new Booking({
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    userName: r.user_name,
    showId: r.show_id,
    status: r.status,
    seatIds: r.seat_ids,
    amount: r.amount,
    currency: r.currency,
    priceBreakdown: r.price_breakdown,
    couponCode: r.coupon_code,
    expiresAt: r.expires_at,
    paymentId: r.payment_id,
    statusReason: r.status_reason,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    confirmedAt: r.confirmed_at,
    cancelledAt: r.cancelled_at,
  });

const SHOW_COLUMNS = `show_id AS "showId", movie_title AS "movieTitle", venue_name AS "venueName", city,
  screen_name AS "screenName", starts_at AS "startsAt", timezone, status`;

/** Data access for the booking service. Methods take a Queryable so they compose inside transactions. */
export const repo = {
  async insertShow(db: Queryable, s: ShowCreatedData): Promise<boolean> {
    const res = await db.query(
      `INSERT INTO shows (show_id, movie_id, movie_title, venue_id, venue_name, city, screen_name, starts_at, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (show_id) DO NOTHING`,
      [s.showId, s.movieId, s.movieTitle, s.venueId, s.venueName, s.city, s.screenName, s.startsAt, s.timezone],
    );
    return res.rowCount === 1;
  },

  /** Bulk insert with UNNEST: one round trip for ~150 seats instead of 150. */
  async insertSeats(db: Queryable, showId: string, seats: SeatDefinition[]): Promise<void> {
    await db.query(
      `INSERT INTO show_seats (show_id, seat_id, row_label, seat_number, category, price)
       SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::int[], $5::text[], $6::int[])
       ON CONFLICT DO NOTHING`,
      [showId, seats.map((s) => s.seatId), seats.map((s) => s.row), seats.map((s) => s.number), seats.map((s) => s.category), seats.map((s) => s.price)],
    );
  },

  async getShow(db: Queryable, showId: string): Promise<ShowRow | undefined> {
    const { rows } = await db.query<ShowRow>(`SELECT ${SHOW_COLUMNS} FROM shows WHERE show_id = $1`, [showId]);
    return rows[0];
  },

  async markShowCancelled(db: Queryable, showId: string): Promise<void> {
    await db.query(`UPDATE shows SET status = 'CANCELLED' WHERE show_id = $1`, [showId]);
  },

  async getSeats(db: Queryable, showId: string, seatIds?: string[], forUpdate = false): Promise<SeatRow[]> {
    const { rows } = await db.query<SeatRow>(
      `SELECT seat_id AS "seatId", row_label AS "row", seat_number AS "number", category, price, status, booking_id AS "bookingId"
       FROM show_seats
       WHERE show_id = $1 ${seatIds ? 'AND seat_id = ANY($2::text[])' : ''}
       ORDER BY row_label, seat_number
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      seatIds ? [showId, seatIds] : [showId],
    );
    return rows;
  },

  /**
   * The double-booking guard of last resort: flips seats to BOOKED only if they are still
   * AVAILABLE. The caller compares the row count with the number of seats it asked for.
   */
  async markSeatsBooked(db: Queryable, showId: string, seatIds: string[], bookingId: string): Promise<number> {
    const res = await db.query(
      `UPDATE show_seats SET status = 'BOOKED', booking_id = $3, updated_at = now()
       WHERE show_id = $1 AND seat_id = ANY($2::text[]) AND status = 'AVAILABLE'`,
      [showId, seatIds, bookingId],
    );
    return res.rowCount ?? 0;
  },

  async releaseSeatsOf(db: Queryable, bookingId: string): Promise<number> {
    const res = await db.query(
      `UPDATE show_seats SET status = 'AVAILABLE', booking_id = NULL, updated_at = now() WHERE booking_id = $1`,
      [bookingId],
    );
    return res.rowCount ?? 0;
  },

  async insertBooking(db: Queryable, b: Booking): Promise<void> {
    const p = b.snapshot();
    await db.query(
      `INSERT INTO bookings (id, user_id, user_email, user_name, show_id, status, seat_ids, amount, currency,
                             price_breakdown, coupon_code, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [p.id, p.userId, p.userEmail, p.userName, p.showId, p.status, p.seatIds, p.amount, p.currency, JSON.stringify(p.priceBreakdown), p.couponCode, p.expiresAt, p.createdAt],
    );
  },

  /**
   * Optimistic concurrency: the UPDATE only applies if nobody else changed the row since we read
   * it (version matches). Callers normally hold a FOR UPDATE lock too; the version check makes
   * the invariant explicit and protects code paths that read without locking.
   */
  async saveBooking(db: Queryable, b: Booking): Promise<void> {
    const p = b.snapshot();
    const res = await db.query(
      `UPDATE bookings SET status = $2, payment_id = $3, status_reason = $4, confirmed_at = $5, cancelled_at = $6,
                           updated_at = now(), version = version + 1
       WHERE id = $1 AND version = $7`,
      [p.id, p.status, p.paymentId, p.statusReason, p.confirmedAt, p.cancelledAt, p.version],
    );
    if (res.rowCount !== 1) throw new Error(`Concurrent modification of booking ${p.id}`);
  },

  async findBooking(db: Queryable, id: string, forUpdate = false): Promise<Booking | undefined> {
    const { rows } = await db.query<BookingRow>(`SELECT * FROM bookings WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id]);
    return rows[0] ? toBooking(rows[0]) : undefined;
  },

  async findPending(db: Queryable, userId: string, showId: string, forUpdate = false): Promise<Booking | undefined> {
    const { rows } = await db.query<BookingRow>(
      `SELECT * FROM bookings WHERE user_id = $1 AND show_id = $2 AND status = 'PENDING' ${forUpdate ? 'FOR UPDATE' : ''}`,
      [userId, showId],
    );
    return rows[0] ? toBooking(rows[0]) : undefined;
  },

  /** Due pending bookings, locked; SKIP LOCKED lets several replicas sweep in parallel. */
  async lockDuePending(db: Queryable, limit: number): Promise<Booking[]> {
    const { rows } = await db.query<BookingRow>(
      `SELECT * FROM bookings WHERE status = 'PENDING' AND expires_at <= now()
       ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return rows.map(toBooking);
  },

  async lockActiveForShow(db: Queryable, showId: string): Promise<Booking[]> {
    const { rows } = await db.query<BookingRow>(
      `SELECT * FROM bookings WHERE show_id = $1 AND status IN ('PENDING', 'CONFIRMED') FOR UPDATE`,
      [showId],
    );
    return rows.map(toBooking);
  },

  async listForUser(db: Queryable, userId: string, limit = 50) {
    const { rows } = await db.query<BookingRow & { movie_title: string; venue_name: string; screen_name: string; city: string; starts_at: Date }>(
      `SELECT b.*, s.movie_title, s.venue_name, s.screen_name, s.city, s.starts_at
       FROM bookings b JOIN shows s USING (show_id)
       WHERE b.user_id = $1
         AND (b.status <> 'PENDING' OR b.expires_at > now())
         -- Abandoned or replaced holds that were never paid are noise in a customer's history.
         AND NOT (b.status IN ('CANCELLED', 'EXPIRED') AND b.payment_id IS NULL)
       ORDER BY b.created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      booking: toBooking(r),
      show: { movieTitle: r.movie_title, venueName: r.venue_name, screenName: r.screen_name, city: r.city, startsAt: r.starts_at },
    }));
  },

  async stats(db: Queryable) {
    const { rows } = await db.query<{ status: string; count: number; revenue: number }>(
      `SELECT status, count(*)::int AS count, coalesce(sum(amount), 0)::int AS revenue FROM bookings GROUP BY status`,
    );
    return rows;
  },
};
