import { ConflictError, UnprocessableError } from '@showtime/common';
import type { Booking } from './booking.js';

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export class InvalidStateTransitionError extends ConflictError {
  constructor(from: BookingStatus, action: string) {
    super('INVALID_BOOKING_STATE', `Cannot ${action} a ${from.toLowerCase()} booking`, { from, action });
  }
}

export interface CancelContext {
  now: Date;
  showStartsAt: Date;
  /** Confirmed bookings can be cancelled until this long before the show. */
  cutoffMs: number;
  /** Venue-initiated cancellation (show cancelled) ignores the cutoff. */
  force?: boolean;
}

export interface CancelOutcome {
  refundRequired: boolean;
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
export abstract class BookingState {
  abstract readonly status: BookingStatus;

  confirm(_booking: Booking, _paymentId: string, _now: Date): void {
    throw new InvalidStateTransitionError(this.status, 'confirm');
  }

  fail(_booking: Booking, _reason: string): void {
    throw new InvalidStateTransitionError(this.status, 'fail');
  }

  expire(_booking: Booking, _now: Date): void {
    throw new InvalidStateTransitionError(this.status, 'expire');
  }

  cancel(_booking: Booking, _ctx: CancelContext): CancelOutcome {
    throw new InvalidStateTransitionError(this.status, 'cancel');
  }

  /** Throws unless a payment may be started for this booking right now. */
  assertPayable(_booking: Booking, _now: Date): void {
    throw new UnprocessableError('BOOKING_NOT_PAYABLE', `This booking is ${this.status.toLowerCase()} and cannot be paid for`);
  }
}

export class PendingState extends BookingState {
  readonly status = 'PENDING' as const;
  /** Do not start a payment that cannot finish before the hold runs out. */
  static readonly MIN_TIME_TO_PAY_MS = 15_000;

  override confirm(booking: Booking, paymentId: string, now: Date): void {
    // Deliberately no expiry check: if the payment landed during the short grace period, the
    // seats are still locked for us in Redis and the DB update is the final arbiter anyway.
    booking.applyTransition(new ConfirmedState(), { paymentId, confirmedAt: now, statusReason: null });
  }

  override fail(booking: Booking, reason: string): void {
    booking.applyTransition(new FailedState(), { statusReason: reason });
  }

  override expire(booking: Booking, now: Date): void {
    if (now.getTime() < booking.expiresAt.getTime()) {
      throw new ConflictError('NOT_EXPIRED', 'Booking hold has not expired yet');
    }
    booking.applyTransition(new ExpiredState(), { statusReason: 'Seat hold expired before payment' });
  }

  override cancel(booking: Booking, ctx: CancelContext): CancelOutcome {
    booking.applyTransition(new CancelledState(), { cancelledAt: ctx.now, statusReason: 'Cancelled before payment' });
    return { refundRequired: false };
  }

  override assertPayable(booking: Booking, now: Date): void {
    if (booking.expiresAt.getTime() - now.getTime() < PendingState.MIN_TIME_TO_PAY_MS) {
      throw new UnprocessableError('HOLD_EXPIRED', 'Your seat hold has expired, please select seats again');
    }
  }
}

export class ConfirmedState extends BookingState {
  readonly status = 'CONFIRMED' as const;

  override cancel(booking: Booking, ctx: CancelContext): CancelOutcome {
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
  readonly status = 'FAILED' as const;
}
export class ExpiredState extends BookingState {
  readonly status = 'EXPIRED' as const;
}
export class CancelledState extends BookingState {
  readonly status = 'CANCELLED' as const;
}

export function stateFor(status: BookingStatus): BookingState {
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
