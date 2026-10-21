import { createHmac, timingSafeEqual } from 'node:crypto';
import { header } from './provider.js';

const API = 'https://api.razorpay.com/v1';

function hmacEquals(secret, data, given) {
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
export class RazorpayProvider {
  name = 'razorpay';

  constructor(keyId, keySecret, webhookSecret) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret;
  }

  get authHeader() {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  async call(path, body) {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: this.authHeader, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`Razorpay ${path} failed: ${json.error?.description ?? res.status}`);
    return json;
  }

  async createOrder(input) {
    const order = await this.call('/orders', {
      amount: input.amount,
      currency: input.currency,
      receipt: input.paymentId,
      notes: { paymentId: input.paymentId },
    });
    return {
      providerOrderId: order.id,
      checkout: { mode: 'razorpay', keyId: this.keyId, orderId: order.id, amount: input.amount, currency: input.currency },
    };
  }

  verifyWebhook(rawBody, headers) {
    return hmacEquals(this.webhookSecret, rawBody, header(headers, 'x-razorpay-signature'));
  }

  /** Signature the Checkout widget returns to the browser after a successful payment. */
  verifyCheckoutSignature(orderId, paymentId, signature) {
    return hmacEquals(this.keySecret, `${orderId}|${paymentId}`, signature);
  }

  parseWebhook(body, headers) {
    const b = body;
    const entity = b.payload?.payment?.entity;
    const eventId = header(headers, 'x-razorpay-event-id');
    if (!entity || !eventId) return null;
    if (b.event === 'payment.captured')
      return { eventId, type: 'payment.captured', providerOrderId: entity.order_id, providerPaymentId: entity.id };
    if (b.event === 'payment.failed') {
      return {
        eventId,
        type: 'payment.failed',
        providerOrderId: entity.order_id,
        providerPaymentId: entity.id,
        reason: entity.error_description ?? 'Payment failed',
      };
    }
    return null;
  }

  async refund(input) {
    const refund = await this.call(`/payments/${input.providerPaymentId}/refund`, {
      amount: input.amount,
      receipt: `refund-${input.paymentId}`,
    });
    return { refundId: refund.id };
  }
}
