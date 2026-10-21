import { stateFor } from './booking-state.js';

/**
 * Booking aggregate. All status changes go through the current BookingState object;
 * there is no public setter for `status`.
 */
export class Booking {
  dirty = false;

  constructor(props) {
    this.props = { ...props };
    this.state = stateFor(props.status);
  }

  get id() {
    return this.props.id;
  }
  get userId() {
    return this.props.userId;
  }
  get showId() {
    return this.props.showId;
  }
  get status() {
    return this.state.status;
  }
  get seatIds() {
    return this.props.seatIds;
  }
  get amount() {
    return this.props.amount;
  }
  get expiresAt() {
    return this.props.expiresAt;
  }
  get paymentId() {
    return this.props.paymentId;
  }
  get version() {
    return this.props.version;
  }
  get isDirty() {
    return this.dirty;
  }

  confirm(paymentId, now = new Date()) {
    this.state.confirm(this, paymentId, now);
  }

  fail(reason) {
    this.state.fail(this, reason);
  }

  expire(now = new Date()) {
    this.state.expire(this, now);
  }

  cancel(ctx) {
    return this.state.cancel(this, ctx);
  }

  assertPayable(now = new Date()) {
    this.state.assertPayable(this, now);
  }

  /** Called only by BookingState subclasses. */
  applyTransition(next, changes) {
    this.state = next;
    this.props = { ...this.props, ...changes, status: next.status, updatedAt: new Date() };
    this.dirty = true;
  }

  snapshot() {
    return { ...this.props, status: this.state.status };
  }
}
