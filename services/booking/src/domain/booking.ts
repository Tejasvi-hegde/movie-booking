import type { PriceBreakdown } from './pricing.js';
import { stateFor, type BookingState, type BookingStatus, type CancelContext, type CancelOutcome } from './booking-state.js';

export interface BookingProps {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  showId: string;
  status: BookingStatus;
  seatIds: string[];
  amount: number;
  currency: string;
  priceBreakdown: PriceBreakdown;
  couponCode: string | null;
  expiresAt: Date;
  paymentId: string | null;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
}

type Mutable = Partial<Pick<BookingProps, 'paymentId' | 'statusReason' | 'confirmedAt' | 'cancelledAt'>>;

/**
 * Booking aggregate. All status changes go through the current BookingState object;
 * there is no public setter for `status`.
 */
export class Booking {
  private state: BookingState;
  private props: BookingProps;
  private dirty = false;

  constructor(props: BookingProps) {
    this.props = { ...props };
    this.state = stateFor(props.status);
  }

  get id() { return this.props.id; }
  get userId() { return this.props.userId; }
  get showId() { return this.props.showId; }
  get status() { return this.state.status; }
  get seatIds() { return this.props.seatIds; }
  get amount() { return this.props.amount; }
  get expiresAt() { return this.props.expiresAt; }
  get paymentId() { return this.props.paymentId; }
  get version() { return this.props.version; }
  get isDirty() { return this.dirty; }

  confirm(paymentId: string, now = new Date()): void {
    this.state.confirm(this, paymentId, now);
  }

  fail(reason: string): void {
    this.state.fail(this, reason);
  }

  expire(now = new Date()): void {
    this.state.expire(this, now);
  }

  cancel(ctx: CancelContext): CancelOutcome {
    return this.state.cancel(this, ctx);
  }

  assertPayable(now = new Date()): void {
    this.state.assertPayable(this, now);
  }

  /** Called only by BookingState subclasses. */
  applyTransition(next: BookingState, changes: Mutable): void {
    this.state = next;
    this.props = { ...this.props, ...changes, status: next.status, updatedAt: new Date() };
    this.dirty = true;
  }

  snapshot(): Readonly<BookingProps> {
    return { ...this.props, status: this.state.status };
  }
}
