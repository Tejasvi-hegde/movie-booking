import { randomUUID } from 'node:crypto';
import {
  BadRequestError,
  buildEvent,
  ConflictError,
  counter,
  enqueueEvent,
  isUniqueViolation,
  NotFoundError,
  UnprocessableError,
  withTransaction,
} from '@showtime/common';
import { Booking } from './domain/booking.js';
import { repo } from './repository.js';

const holdAttempts = counter('seat_hold_attempts_total', 'Seat hold attempts', ['outcome']);
const bookingTransitions = counter('booking_transitions_total', 'Booking status changes', ['status']);

export function bookingDto(b, show) {
  const p = b.snapshot();
  return {
    id: p.id,
    showId: p.showId,
    status: p.status,
    seats: p.seatIds,
    amount: p.amount,
    currency: p.currency,
    priceBreakdown: p.priceBreakdown,
    couponCode: p.couponCode,
    expiresAt: p.expiresAt.toISOString(),
    paymentId: p.paymentId,
    statusReason: p.statusReason,
    createdAt: p.createdAt.toISOString(),
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    show: show
      ? {
          movieTitle: show.movieTitle,
          venueName: show.venueName,
          screenName: show.screenName,
          city: show.city,
          startsAt: new Date(show.startsAt).toISOString(),
        }
      : undefined,
  };
}

export class BookingService {
  constructor(pool, locks, pricing, seatEvents, relay, settings, logger) {
    this.pool = pool;
    this.locks = locks;
    this.pricing = pricing;
    this.seatEvents = seatEvents;
    this.relay = relay;
    this.settings = settings;
    this.logger = logger;
  }

  // ── queries ──────────────────────────────────────────────────────────────────

  async seatMap(showId, userId) {
    const show = await repo.getShow(this.pool, showId);
    if (!show) throw new NotFoundError('Show');
    const seats = await repo.getSeats(this.pool, showId);
    const [holders, mine] = await Promise.all([
      this.locks.holders(
        showId,
        seats.filter((s) => s.status === 'AVAILABLE').map((s) => s.seatId),
      ),
      userId ? repo.findPending(this.pool, userId, showId) : Promise.resolve(undefined),
    ]);
    const myHold = mine && mine.expiresAt.getTime() > Date.now() ? mine : undefined;
    return {
      show: {
        id: show.showId,
        movieTitle: show.movieTitle,
        venueName: show.venueName,
        screenName: show.screenName,
        city: show.city,
        startsAt: show.startsAt,
        status: show.status,
      },
      seats: seats.map((s) => {
        const holder = holders.get(s.seatId);
        const status = s.status === 'BOOKED' ? 'BOOKED' : holder ? (holder === myHold?.id ? 'HELD_BY_YOU' : 'HELD') : 'AVAILABLE';
        return { seatId: s.seatId, row: s.row, number: s.number, category: s.category, price: s.price, status };
      }),
      myHold: myHold ? bookingDto(myHold, show) : null,
      maxSeatsPerBooking: this.settings.maxSeatsPerBooking,
    };
  }

  async quote(input) {
    const seatIds = this.normalizeSeats(input.seatIds);
    const show = await this.requireBookableShow(input.showId);
    const seats = await repo.getSeats(this.pool, show.showId, seatIds);
    if (seats.length !== seatIds.length) throw new BadRequestError('Unknown seat(s) for this show');
    return this.pricing.price({ seats, showStartsAt: show.startsAt, timezone: show.timezone, couponCode: input.couponCode });
  }

  async getForUser(user, id) {
    const booking = await repo.findBooking(this.pool, id);
    if (!booking || (booking.userId !== user.id && user.role !== 'ADMIN')) throw new NotFoundError('Booking');
    return bookingDto(booking, await repo.getShow(this.pool, booking.showId));
  }

  async listForUser(user) {
    const rows = await repo.listForUser(this.pool, user.id);
    return rows.map((r) => bookingDto(r.booking, r.show));
  }

  /** For the payment service: is this booking payable right now, and for how much? */
  async getForPayment(id) {
    const booking = await repo.findBooking(this.pool, id);
    if (!booking) throw new NotFoundError('Booking');
    let payable = { ok: true };
    try {
      booking.assertPayable();
    } catch (err) {
      const e = err;
      payable = { ok: false, code: e.code, message: e.message };
    }
    const p = booking.snapshot();
    return {
      id: p.id,
      userId: p.userId,
      userEmail: p.userEmail,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      expiresAt: p.expiresAt.toISOString(),
      payable,
    };
  }

  async stats() {
    return repo.stats(this.pool);
  }

  // ── commands ─────────────────────────────────────────────────────────────────

  /**
   * Step 1 of a booking: hold seats.
   *
   *  1. Cheap validation against the DB (seats exist, not sold).
   *  2. Atomically lock every seat in Redis (all-or-nothing Lua script, TTL = hold + grace).
   *  3. Re-check inside a transaction (a seat may have been sold between 1 and 2) and insert
   *     the PENDING booking. On any failure the Redis locks are released again.
   */
  async hold(user, input) {
    const seatIds = this.normalizeSeats(input.seatIds);
    const show = await this.requireBookableShow(input.showId);
    const seats = await repo.getSeats(this.pool, show.showId, seatIds);
    if (seats.length !== seatIds.length) {
      const known = new Set(seats.map((s) => s.seatId));
      throw new BadRequestError('Unknown seat(s) for this show', { seatIds: seatIds.filter((s) => !known.has(s)) });
    }
    const sold = seats.filter((s) => s.status === 'BOOKED').map((s) => s.seatId);
    if (sold.length) {
      holdAttempts.inc({ outcome: 'sold' });
      throw new ConflictError('SEATS_UNAVAILABLE', 'Some of these seats were just booked', { seatIds: sold });
    }
    const breakdown = this.pricing.price({ seats, showStartsAt: show.startsAt, timezone: show.timezone, couponCode: input.couponCode });

    // Choosing seats again replaces any earlier hold this user has for the same show.
    await this.cancelPendingHold(user.id, show.showId);

    const bookingId = randomUUID();
    const lock = await this.locks.acquire(show.showId, seatIds, bookingId, this.settings.holdTtlMs + this.settings.holdGraceMs);
    if (!lock.ok) {
      holdAttempts.inc({ outcome: 'conflict' });
      throw new ConflictError('SEATS_UNAVAILABLE', 'Someone else is holding some of these seats', { seatIds: lock.conflicts });
    }

    const now = new Date();
    const booking = new Booking({
      id: bookingId,
      userId: user.id,
      userEmail: user.email,
      userName: user.name,
      showId: show.showId,
      status: 'PENDING',
      seatIds,
      amount: breakdown.total,
      currency: 'INR',
      priceBreakdown: breakdown,
      couponCode: input.couponCode?.trim().toUpperCase() || null,
      expiresAt: new Date(now.getTime() + this.settings.holdTtlMs),
      paymentId: null,
      statusReason: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      cancelledAt: null,
    });

    try {
      await withTransaction(this.pool, async (tx) => {
        const fresh = await repo.getSeats(tx, show.showId, seatIds);
        const nowSold = fresh.filter((s) => s.status === 'BOOKED').map((s) => s.seatId);
        if (nowSold.length) throw new ConflictError('SEATS_UNAVAILABLE', 'Some of these seats were just booked', { seatIds: nowSold });
        await repo.insertBooking(tx, booking);
      });
    } catch (err) {
      await this.locks.release(show.showId, seatIds, bookingId);
      holdAttempts.inc({ outcome: 'error' });
      if (isUniqueViolation(err, 'bookings_one_pending_per_user_show')) {
        throw new ConflictError('HOLD_IN_PROGRESS', 'You already have a hold being created for this show, try again');
      }
      throw err;
    }

    holdAttempts.inc({ outcome: 'success' });
    bookingTransitions.inc({ status: 'PENDING' });
    this.seatEvents.notify(show.showId, { seatIds, status: 'HELD' });
    this.logger.info({ bookingId, showId: show.showId, seats: seatIds, amount: breakdown.total }, 'Seats held');
    return bookingDto(booking, show);
  }

  async cancel(user, bookingId) {
    const after = [];
    const result = await withTransaction(this.pool, async (tx) => {
      const booking = await repo.findBooking(tx, bookingId, true);
      if (!booking || (booking.userId !== user.id && user.role !== 'ADMIN')) throw new NotFoundError('Booking');
      const show = await repo.getShow(tx, booking.showId);
      await this.cancelInTx(tx, booking, show, { force: false }, after);
      return bookingDto(booking, show);
    });
    await this.runAfterCommit(after);
    return result;
  }

  // ── event handlers (all idempotent: delivery is at-least-once) ───────────────

  async onShowCreated(data) {
    await withTransaction(this.pool, async (tx) => {
      const inserted = await repo.insertShow(tx, data);
      if (inserted) await repo.insertSeats(tx, data.showId, data.seats);
    });
  }

  async onShowCancelled(data) {
    const after = [];
    await withTransaction(this.pool, async (tx) => {
      const show = await repo.getShow(tx, data.showId);
      if (!show) return;
      await repo.markShowCancelled(tx, data.showId);
      for (const booking of await repo.lockActiveForShow(tx, data.showId)) {
        await this.cancelInTx(tx, booking, show, { force: true, reason: data.reason }, after);
      }
    });
    await this.runAfterCommit(after);
  }

  /**
   * Saga step: payment captured → try to confirm.
   * If the seats can no longer be honoured, the booking fails and we emit an event asking the
   * payment service to refund (the compensating action).
   */
  async onPaymentSucceeded(data) {
    const after = [];
    await withTransaction(this.pool, async (tx) => {
      const booking = await repo.findBooking(tx, data.bookingId, true);
      if (!booking) {
        this.logger.error({ ...data }, 'Payment for unknown booking');
        return;
      }
      const p = booking.snapshot();
      if (booking.status === 'CONFIRMED' && booking.paymentId === data.paymentId) return; // duplicate delivery

      const refund = async (reason) =>
        enqueueEvent(
          tx,
          buildEvent(
            'booking.failed',
            {
              bookingId: p.id,
              userId: p.userId,
              userEmail: p.userEmail,
              userName: p.userName,
              showId: p.showId,
              reason,
              paymentId: data.paymentId,
              refundRequired: true,
            },
            'booking',
          ),
        );

      if (booking.status !== 'PENDING') {
        await refund(
          booking.status === 'CONFIRMED'
            ? 'Duplicate payment for a confirmed booking'
            : `Payment arrived after the booking was ${booking.status.toLowerCase()}`,
        );
        return;
      }

      const show = await repo.getShow(tx, booking.showId);
      const lockSurelyGone = Date.now() > booking.expiresAt.getTime() + this.settings.holdGraceMs;
      const seats = await repo.getSeats(tx, booking.showId, booking.seatIds, true); // row locks
      const allAvailable = seats.length === booking.seatIds.length && seats.every((s) => s.status === 'AVAILABLE');

      if (lockSurelyGone || !allAvailable || show.status !== 'SCHEDULED') {
        const reason =
          show.status !== 'SCHEDULED'
            ? 'Show was cancelled'
            : lockSurelyGone
              ? 'Seat hold expired before payment completed'
              : 'Seats were no longer available';
        booking.fail(reason);
        await repo.saveBooking(tx, booking);
        await refund(reason);
        bookingTransitions.inc({ status: 'FAILED' });
        after.push(
          () => this.locks.release(booking.showId, booking.seatIds, booking.id),
          () => this.seatEvents.notify(booking.showId, { seatIds: booking.seatIds, status: 'RELEASED' }),
        );
        return;
      }

      const updated = await repo.markSeatsBooked(tx, booking.showId, booking.seatIds, booking.id);
      if (updated !== booking.seatIds.length) throw new Error(`Seat update mismatch for booking ${booking.id}`); // rolls back; retried
      booking.confirm(data.paymentId);
      await repo.saveBooking(tx, booking);
      await enqueueEvent(
        tx,
        buildEvent(
          'booking.confirmed',
          {
            bookingId: p.id,
            userId: p.userId,
            userEmail: p.userEmail,
            userName: p.userName,
            showId: p.showId,
            paymentId: data.paymentId,
            amount: p.amount,
            currency: p.currency,
            seats: p.seatIds,
            movieTitle: show.movieTitle,
            venueName: show.venueName,
            screenName: show.screenName,
            startsAt: new Date(show.startsAt).toISOString(),
          },
          'booking',
        ),
      );
      bookingTransitions.inc({ status: 'CONFIRMED' });
      // Sold seats are guarded by Postgres from now on; the temporary Redis hold is no longer needed.
      after.push(
        () => this.locks.release(booking.showId, booking.seatIds, booking.id),
        () => this.seatEvents.notify(booking.showId, { seatIds: booking.seatIds, status: 'BOOKED' }),
      );
      this.logger.info({ bookingId: p.id, paymentId: data.paymentId }, 'Booking confirmed');
    });
    await this.runAfterCommit(after);
  }

  async onPaymentFailed(data) {
    const after = [];
    await withTransaction(this.pool, async (tx) => {
      const booking = await repo.findBooking(tx, data.bookingId, true);
      if (!booking || booking.status !== 'PENDING') return;
      const p = booking.snapshot();
      booking.fail(`Payment failed: ${data.reason}`);
      await repo.saveBooking(tx, booking);
      await enqueueEvent(
        tx,
        buildEvent(
          'booking.failed',
          {
            bookingId: p.id,
            userId: p.userId,
            userEmail: p.userEmail,
            userName: p.userName,
            showId: p.showId,
            reason: data.reason,
            refundRequired: false,
          },
          'booking',
        ),
      );
      bookingTransitions.inc({ status: 'FAILED' });
      after.push(
        () => this.locks.release(p.showId, p.seatIds, p.id),
        () => this.seatEvents.notify(p.showId, { seatIds: p.seatIds, status: 'RELEASED' }),
      );
    });
    await this.runAfterCommit(after);
  }

  /** Background sweeper: expires unpaid holds. Safe to run on every replica (SKIP LOCKED). */
  async expireDue(limit = 100) {
    const after = [];
    const count = await withTransaction(this.pool, async (tx) => {
      const due = await repo.lockDuePending(tx, limit);
      for (const booking of due) {
        const p = booking.snapshot();
        booking.expire();
        await repo.saveBooking(tx, booking);
        await enqueueEvent(
          tx,
          buildEvent(
            'booking.expired',
            { bookingId: p.id, userId: p.userId, userEmail: p.userEmail, userName: p.userName, showId: p.showId, seats: p.seatIds },
            'booking',
          ),
        );
        bookingTransitions.inc({ status: 'EXPIRED' });
        after.push(
          () => this.locks.release(p.showId, p.seatIds, p.id),
          () => this.seatEvents.notify(p.showId, { seatIds: p.seatIds, status: 'RELEASED' }),
        );
      }
      return due.length;
    });
    await this.runAfterCommit(after);
    if (count) this.logger.info({ count }, 'Expired unpaid holds');
    return count;
  }

  // ── internals ────────────────────────────────────────────────────────────────

  async cancelPendingHold(userId, showId) {
    const after = [];
    await withTransaction(this.pool, async (tx) => {
      const existing = await repo.findPending(tx, userId, showId, true);
      if (!existing) return;
      const show = await repo.getShow(tx, showId);
      await this.cancelInTx(tx, existing, show, { force: false, reason: 'Replaced by a new seat selection' }, after);
    });
    await this.runAfterCommit(after);
  }

  async cancelInTx(tx, booking, show, opts, after) {
    const wasPending = booking.status === 'PENDING';
    const p = booking.snapshot();
    const { refundRequired } = booking.cancel({
      now: new Date(),
      showStartsAt: new Date(show.startsAt),
      cutoffMs: this.settings.cancellationCutoffMs,
      force: opts.force,
    });
    if (!wasPending) await repo.releaseSeatsOf(tx, booking.id);
    await repo.saveBooking(tx, booking);
    await enqueueEvent(
      tx,
      buildEvent(
        'booking.cancelled',
        {
          bookingId: p.id,
          userId: p.userId,
          userEmail: p.userEmail,
          userName: p.userName,
          showId: p.showId,
          reason: opts.reason ?? booking.snapshot().statusReason ?? 'Cancelled',
          paymentId: p.paymentId ?? undefined,
          refundRequired,
          amount: p.amount,
          seats: p.seatIds,
          movieTitle: show.movieTitle,
        },
        'booking',
      ),
    );
    bookingTransitions.inc({ status: 'CANCELLED' });
    if (wasPending) after.push(() => this.locks.release(p.showId, p.seatIds, p.id));
    after.push(() => this.seatEvents.notify(p.showId, { seatIds: p.seatIds, status: 'RELEASED' }));
  }

  async runAfterCommit(after) {
    for (const fn of after) {
      try {
        await fn();
      } catch (err) {
        // Redis locks have a TTL, so a failed release heals itself; log and continue.
        this.logger.warn({ err }, 'Post-commit step failed');
      }
    }
    void this.relay.kick();
  }

  normalizeSeats(seatIds) {
    const unique = [...new Set(seatIds.map((s) => s.trim().toUpperCase()))].filter(Boolean);
    if (!unique.length) throw new BadRequestError('Select at least one seat');
    if (unique.length > this.settings.maxSeatsPerBooking) {
      throw new BadRequestError(`You can book at most ${this.settings.maxSeatsPerBooking} seats at a time`);
    }
    // Natural order (A2 before A10) so seat lists read the way they appear in the hall.
    return unique.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }

  async requireBookableShow(showId) {
    const show = await repo.getShow(this.pool, showId);
    if (!show) throw new NotFoundError('Show');
    if (show.status !== 'SCHEDULED') throw new UnprocessableError('SHOW_CANCELLED', 'This show has been cancelled');
    if (new Date(show.startsAt).getTime() <= Date.now())
      throw new UnprocessableError('BOOKING_CLOSED', 'Bookings for this show have closed');
    return show;
  }
}
