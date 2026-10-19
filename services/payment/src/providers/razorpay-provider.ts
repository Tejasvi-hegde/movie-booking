import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { header, type CreateOrderInput, type CreateOrderResult, type PaymentProvider, type ProviderEvent } from './provider.js';

const API = 'https://api.razorpay.com/v1';

interface RazorpayWebhook {
  event: string;
  payload?: { payment?: { entity?: { id: string; order_id: string; error_description?: string } } };
}

function hmacEquals(secret: string, data: string | Buffer, given: string | undefined): boolean {
  if (!given) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(data).digest('hex'));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Razorpay (test mode works without a business account: create keys in the dashboard and
 * point a webhook at /api/payments/webhooks/razorpay with the events payment.captured and
 * payment.failed).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
  ) {}

  private get authHeader() {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: this.authHeader, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(`Razorpay ${path} failed: ${json.error?.description ?? res.status}`);
    return json;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const order = await this.call<{ id: string }>('/orders', {
      amount: input.amount,
      currency: input.currency,
      receipt: input.paymentId,
      notes: { paymentId: input.paymentId },
    });
    return { providerOrderId: order.id, checkout: { mode: 'razorpay', keyId: this.keyId, orderId: order.id, amount: input.amount, currency: input.currency } };
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    return hmacEquals(this.webhookSecret, rawBody, header(headers, 'x-razorpay-signature'));
  }

  /** Signature the Checkout widget returns to the browser after a successful payment. */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacEquals(this.keySecret, `${orderId}|${paymentId}`, signature);
  }

  parseWebhook(body: unknown, headers: IncomingHttpHeaders): ProviderEvent | null {
    const b = body as RazorpayWebhook;
    const entity = b.payload?.payment?.entity;
    const eventId = header(headers, 'x-razorpay-event-id');
    if (!entity || !eventId) return null;
    if (b.event === 'payment.captured') return { eventId, type: 'payment.captured', providerOrderId: entity.order_id, providerPaymentId: entity.id };
    if (b.event === 'payment.failed') {
      return { eventId, type: 'payment.failed', providerOrderId: entity.order_id, providerPaymentId: entity.id, reason: entity.error_description ?? 'Payment failed' };
    }
    return null;
  }

  async refund(input: { providerPaymentId: string; amount: number; paymentId: string }): Promise<{ refundId: string }> {
    const refund = await this.call<{ id: string }>(`/payments/${input.providerPaymentId}/refund`, {
      amount: input.amount,
      receipt: `refund-${input.paymentId}`,
    });
    return { refundId: refund.id };
  }
}
