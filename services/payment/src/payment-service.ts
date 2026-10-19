import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  buildEvent,
  ConflictError,
  counter,
  enqueueEvent,
  isUniqueViolation,
  NotFoundError,
  rethrowUpstream,
  UnauthorizedError,
  UnprocessableError,
  withTransaction,
  type AuthUser,
  type Logger,
  type Pool,
  type PoolClient,
  type ServiceClient,
} from '@showtime/common';
import type { PaymentProviderFactory } from './providers/provider-factory.js';
import type { ProviderEvent } from './providers/provider.js';
import type { RazorpayProvider } from './providers/razorpay-provider.js';

const paymentOutcomes = counter('payments_total', 'Payment status changes', ['provider', 'status']);

export type PaymentStatus = 'CREATED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';

interface PaymentRow {
  id: string;
  booking_id: string;
  user_id: string;
  user_email: string | null;
  amount: number;
  currency: string;
  provider: string;
  provider_order_id: string;
  provider_payment_id: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  refund_id: string | null;
  refund_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface BookingForPayment {
  id: string;
  userId: string;
  userEmail: string;
  status: string;
  amount: number;
  currency: string;
  expiresAt: string;
  payable: { ok: boolean; code?: string; message?: string };
}

const dto = (p: PaymentRow, checkout?: Record<string, unknown>) => ({
  id: p.id,
  bookingId: p.booking_id,
  amount: p.amount,
  currency: p.currency,
  provider: p.provider,
  status: p.status,
  failureReason: p.failure_reason,
  refundReason: p.refund_reason,
  createdAt: p.created_at.toISOString(),
  updatedAt: p.updated_at.toISOString(),
  ...(checkout ? { checkout } : {}),
});

/** What the frontend needs to (re)open the checkout for an existing order. */
const checkoutFor = (p: PaymentRow, razorpayKeyId?: string) =>
  p.provider === 'razorpay'
    ? { mode: 'razorpay', keyId: razorpayKeyId, orderId: p.provider_order_id, amount: p.amount, currency: p.currency }
    : { mode: 'mock', orderId: p.provider_order_id };

export class PaymentService {
  constructor(
    private readonly pool: Pool,
    private readonly providers: PaymentProviderFactory,
    private readonly bookingClient: ServiceClient,
    private readonly relay: { kick(): unknown },
    private readonly logger: Logger,
    private readonly razorpayKeyId?: string,
  ) {}

  /**
   * Starts (or resumes) a payment for a booking. The amount always comes from the booking
   * service — never from the client — so nobody can pay ₹1 for a ₹500 ticket.
   */
  async createIntent(user: AuthUser, bookingId: string, requestId?: string) {
    const booking = await this.bookingClient.get<BookingForPayment>(`/internal/bookings/${bookingId}`, requestId).catch(rethrowUpstream);
    if (booking.userId !== user.id) throw new NotFoundError('Booking');
    if (!booking.payable.ok) throw new UnprocessableError(booking.payable.code ?? 'BOOKING_NOT_PAYABLE', booking.payable.message ?? 'Booking cannot be paid for');

    const open = await this.findOpen(bookingId);
    if (open) return dto(open, checkoutFor(open, this.razorpayKeyId));

    const provider = this.providers.default;
    const paymentId = randomUUID();
    const order = await provider.createOrder({ paymentId, amount: booking.amount, currency: booking.currency });
    try {
      const { rows } = await this.pool.query<PaymentRow>(
        `INSERT INTO payments (id, booking_id, user_id, user_email, amount, currency, provider, provider_order_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CREATED') RETURNING *`,
        [paymentId, bookingId, user.id, booking.userEmail, booking.amount, booking.currency, provider.name, order.providerOrderId],
      );
      paymentOutcomes.inc({ provider: provider.name, status: 'CREATED' });
      return dto(rows[0]!, order.checkout);
    } catch (err) {
      // Two concurrent requests raced; the partial unique index let only one win. Return the winner.
      if (isUniqueViolation(err, 'payments_one_open_per_booking')) {
        const winner = await this.findOpen(bookingId);
        if (winner) return dto(winner, checkoutFor(winner, this.razorpayKeyId));
      }
      throw err;
    }
  }

  async get(user: AuthUser, id: string) {
    const { rows } = await this.pool.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [id]);
    const p = rows[0];
    if (!p || (p.user_id !== user.id && user.role !== 'ADMIN')) throw new NotFoundError('Payment');
    return dto(p);
  }

  /** Entry point for provider webhooks (and the mock gateway, which uses the exact same path). */
  async handleWebhook(providerName: string, rawBody: Buffer | undefined, body: unknown, headers: IncomingHttpHeaders) {
    const provider = this.providers.get(providerName);
    if (!rawBody || !provider.verifyWebhook(rawBody, headers)) throw new UnauthorizedError('Invalid webhook signature');
    const event = provider.parseWebhook(body, headers);
    if (!event) return { status: 'ignored' as const };
    return this.applyProviderEvent(provider.name, event);
  }

  /** Demo checkout: simulates the gateway sending a signed webhook for this payment. */
  async completeMock(user: AuthUser, paymentId: string, outcome: 'success' | 'failure') {
    const { rows } = await this.pool.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
    const p = rows[0];
    if (!p || p.user_id !== user.id) throw new NotFoundError('Payment');
    if (p.provider !== 'mock') throw new UnprocessableError('NOT_MOCK', 'This payment is not using the mock gateway');
    if (p.status !== 'CREATED') throw new ConflictError('PAYMENT_NOT_OPEN', `Payment is already ${p.status.toLowerCase()}`);
    const { rawBody, headers } = this.providers.mock.simulate(p.provider_order_id, outcome);
    await this.handleWebhook('mock', rawBody, JSON.parse(rawBody.toString()), headers);
    return this.get(user, paymentId);
  }

  /** Razorpay Checkout callback: the browser hands us the signed result right after paying. */
  async verifyRazorpayCheckout(user: AuthUser, paymentId: string, body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) {
    const { rows } = await this.pool.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
    const p = rows[0];
    if (!p || p.user_id !== user.id || p.provider !== 'razorpay' || p.provider_order_id !== body.razorpay_order_id) throw new NotFoundError('Payment');
    const provider = this.providers.get('razorpay') as RazorpayProvider;
    if (!provider.verifyCheckoutSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
      throw new UnauthorizedError('Invalid payment signature');
    }
    await this.applyProviderEvent('razorpay', {
      eventId: `checkout:${body.razorpay_payment_id}`,
      type: 'payment.captured',
      providerOrderId: body.razorpay_order_id,
      providerPaymentId: body.razorpay_payment_id,
    });
    return this.get(user, paymentId);
  }

  /**
   * Applies a provider event exactly once: the event id is inserted into webhook_events in the
   * same transaction as the status change and the outbox event. A replayed webhook hits the
   * primary key and becomes a no-op.
   */
  async applyProviderEvent(provider: string, event: ProviderEvent) {
    const result = await withTransaction(this.pool, async (tx) => {
      const fresh = await tx.query(
        'INSERT INTO webhook_events (provider, event_id, event_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [provider, event.eventId, event.type],
      );
      if (!fresh.rowCount) return 'duplicate' as const;

      const { rows } = await tx.query<PaymentRow>('SELECT * FROM payments WHERE provider = $1 AND provider_order_id = $2 FOR UPDATE', [provider, event.providerOrderId]);
      const p = rows[0];
      if (!p) {
        this.logger.warn({ provider, event }, 'Webhook for unknown order');
        return 'unknown_order' as const;
      }

      if (event.type === 'payment.captured') {
        // CANCELLED/FAILED can still become SUCCEEDED: money really was captured (e.g. a late
        // webhook after the hold expired). Booking will then reject it and ask us to refund.
        if (p.status === 'SUCCEEDED' || p.status === 'REFUNDED') return 'noop' as const;
        await this.setStatus(tx, p.id, 'SUCCEEDED', { provider_payment_id: event.providerPaymentId ?? null, failure_reason: null });
        await enqueueEvent(tx, buildEvent('payment.succeeded', { paymentId: p.id, bookingId: p.booking_id, userId: p.user_id, amount: p.amount, provider }, 'payment'));
        paymentOutcomes.inc({ provider, status: 'SUCCEEDED' });
        return 'succeeded' as const;
      }

      if (p.status !== 'CREATED') return 'noop' as const;
      const reason = event.reason ?? 'Payment failed';
      await this.setStatus(tx, p.id, 'FAILED', { failure_reason: reason });
      await enqueueEvent(tx, buildEvent('payment.failed', { paymentId: p.id, bookingId: p.booking_id, userId: p.user_id, reason }, 'payment'));
      paymentOutcomes.inc({ provider, status: 'FAILED' });
      return 'failed' as const;
    });
    void this.relay.kick();
    this.logger.info({ provider, eventId: event.eventId, type: event.type, result }, 'Provider event processed');
    return { status: result };
  }

  /** Compensating action of the booking saga. Safe to call repeatedly. */
  async refund(paymentId: string, reason: string, userEmail?: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
      const p = rows[0];
      if (!p) {
        this.logger.error({ paymentId }, 'Refund requested for unknown payment');
        return;
      }
      if (p.status !== 'SUCCEEDED') return; // already refunded, or money never captured
      const provider = this.providers.get(p.provider);
      // If the provider call fails we throw, the transaction rolls back, the event stays
      // unacknowledged and is retried later — the refund is never silently lost.
      const { refundId } = await provider.refund({ providerPaymentId: p.provider_payment_id ?? '', amount: p.amount, paymentId: p.id });
      await this.setStatus(tx, p.id, 'REFUNDED', { refund_id: refundId, refund_reason: reason });
      await enqueueEvent(
        tx,
        buildEvent('payment.refunded', { paymentId: p.id, bookingId: p.booking_id, userId: p.user_id, userEmail: userEmail ?? p.user_email ?? undefined, amount: p.amount, reason }, 'payment'),
      );
      paymentOutcomes.inc({ provider: p.provider, status: 'REFUNDED' });
      this.logger.info({ paymentId, refundId, reason }, 'Payment refunded');
    });
    void this.relay.kick();
  }

  /** A booking that ended without payment must not be payable any more. */
  async cancelOpenIntents(bookingId: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE payments SET status = 'CANCELLED', updated_at = now() WHERE booking_id = $1 AND status = 'CREATED'`,
      [bookingId],
    );
    return res.rowCount ?? 0;
  }

  private async findOpen(bookingId: string): Promise<PaymentRow | undefined> {
    const { rows } = await this.pool.query<PaymentRow>(`SELECT * FROM payments WHERE booking_id = $1 AND status = 'CREATED'`, [bookingId]);
    return rows[0];
  }

  private async setStatus(tx: PoolClient, id: string, status: PaymentStatus, fields: Record<string, string | null>) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    await tx.query(`UPDATE payments SET status = $2, updated_at = now()${sets ? `, ${sets}` : ''} WHERE id = $1`, [id, status, ...keys.map((k) => fields[k])]);
  }
}
