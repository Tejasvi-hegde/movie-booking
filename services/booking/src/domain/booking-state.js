import { ConflictError, UnprocessableError } from '@showtime/common';

export class InvalidStateTransitionError extends ConflictError {
  constructor(from, action) {
    super('INVALID_BOOKING_STATE', `Cannot ${action} a ${from.toLowerCase()} booking`, { from, action });
  }
}

/**
 * State pattern: each status is a class that knows which actions are legal from it.
 * Illegal transitions (e.g. confirming an expired booking) throw instead of silently corrupting
 * data, and adding a status means adding a class rather than editing switch statements
 * scattered across the codebase.
 *
 *   PENDING ──confirm──▶ CONFIRMED ──cancel (refund)──▶ CANCELLED
 *      │                                                  ▲
 *      ├──fail────▶ FAILED                                │
 *      ├──expire──▶ EXPIRED                               │
 *      └──cancel (no charge yet) ─────────────────────────┘
 */
export class BookingState {
  confirm(_booking, _paymentId, _now) {
    throw new InvalidStateTransitionError(this.status, 'confirm');
  }

  fail(_booking, _reason) {
    throw new InvalidStateTransitionError(this.status, 'fail');
  }

  expire(_booking, _now) {
    throw new InvalidStateTransitionError(this.status, 'expire');
  }

  cancel(_booking, _ctx) {
    throw new InvalidStateTransitionError(this.status, 'cancel');
  }

  /** Throws unless a payment may be started for this booking right now. */
  assertPayable(_booking, _now) {
    throw new UnprocessableError('BOOKING_NOT_PAYABLE', `This booking is ${this.status.toLowerCase()} and cannot be paid for`);
  }
}

export class PendingState extends BookingState {
  status = 'PENDING';
  /** Do not start a payment that cannot finish before the hold runs out. */
  static MIN_TIME_TO_PAY_MS = 15_000;

  confirm(booking, paymentId, now) {
    // Deliberately no expiry check: if the payment landed during the short grace period, the
    // seats are still locked for us in Redis and the DB update is the final arbiter anyway.
    booking.applyTransition(new ConfirmedState(), { paymentId, confirmedAt: now, statusReason: null });
  }

  fail(booking, reason) {
    booking.applyTransition(new FailedState(), { statusReason: reason });
  }

  expire(booking, now) {
    if (now.getTime() < booking.expiresAt.getTime()) {
      throw new ConflictError('NOT_EXPIRED', 'Booking hold has not expired yet');
    }
    booking.applyTransition(new ExpiredState(), { statusReason: 'Seat hold expired before payment' });
  }

  cancel(booking, ctx) {
    booking.applyTransition(new CancelledState(), { cancelledAt: ctx.now, statusReason: 'Cancelled before payment' });
    return { refundRequired: false };
  }

  assertPayable(booking, now) {
    if (booking.expiresAt.getTime() - now.getTime() < PendingState.MIN_TIME_TO_PAY_MS) {
      throw new UnprocessableError('HOLD_EXPIRED', 'Your seat hold has expired, please select seats again');
    }
  }
}

export class ConfirmedState extends BookingState {
  status = 'CONFIRMED';

  cancel(booking, ctx) {
    const msLeft = ctx.showStartsAt.getTime() - ctx.now.getTime();
    if (!ctx.force && msLeft < ctx.cutoffMs) {
      throw new UnprocessableError(
        'CANCELLATION_WINDOW_CLOSED',
        `Bookings can only be cancelled up to ${Math.round(ctx.cutoffMs / 3_600_000)} hours before the show`,
      );
    }
    booking.applyTransition(new CancelledState(), {
      cancelledAt: ctx.now,
      statusReason: ctx.force ? 'Show cancelled by venue' : 'Cancelled by customer',
    });
    return { refundRequired: true };
  }
}

/** FAILED, EXPIRED and CANCELLED are terminal: every action is rejected by the base class. */
export class FailedState extends BookingState {
  status = 'FAILED';
}
export class ExpiredState extends BookingState {
  status = 'EXPIRED';
}
export class CancelledState extends BookingState {
  status = 'CANCELLED';
}

export function stateFor(status) {
  switch (status) {
    case 'PENDING':
      return new PendingState();
    case 'CONFIRMED':
      return new ConfirmedState();
    case 'FAILED':
      return new FailedState();
    case 'EXPIRED':
      return new ExpiredState();
    case 'CANCELLED':
      return new CancelledState();
  }
}
