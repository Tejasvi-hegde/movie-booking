import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { header } from './provider.js';

const SIGNATURE_HEADER = 'x-mock-signature';

/**
 * A fake gateway that behaves like a real one: orders, HMAC-signed webhooks, refunds.
 * `simulate()` produces exactly the signed webhook a real provider would send, and it goes
 * through the same verification + processing code as a real webhook.
 */
export class MockPaymentProvider {
  name = 'mock';

  constructor(webhookSecret) {
    this.webhookSecret = webhookSecret;
  }

  async createOrder(_input) {
    const providerOrderId = `order_mock_${randomBytes(8).toString('hex')}`;
    return { providerOrderId, checkout: { mode: 'mock', orderId: providerOrderId } };
  }

  sign(rawBody) {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody, headers) {
    const given = header(headers, SIGNATURE_HEADER);
    if (!given) return false;
    const expected = Buffer.from(this.sign(rawBody));
    const actual = Buffer.from(given);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  parseWebhook(body) {
    const b = body;
    if (!b?.id || !b.payload?.order_id) return null;
    if (b.event !== 'payment.captured' && b.event !== 'payment.failed') return null;
    return {
      eventId: b.id,
      type: b.event,
      providerOrderId: b.payload.order_id,
      providerPaymentId: b.payload.payment_id,
      reason: b.payload.error,
    };
  }

  async refund(_input) {
    return { refundId: `rfnd_mock_${randomBytes(8).toString('hex')}` };
  }

  /** Builds the signed webhook the "gateway" would send for this order. */
  simulate(providerOrderId, outcome) {
    const body = {
      id: `evt_mock_${randomBytes(8).toString('hex')}`,
      event: outcome === 'success' ? 'payment.captured' : 'payment.failed',
      payload: {
        order_id: providerOrderId,
        payment_id: `pay_mock_${randomBytes(8).toString('hex')}`,
        ...(outcome === 'failure' ? { error: 'Card declined by issuing bank (simulated)' } : {}),
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    return { rawBody, headers: { [SIGNATURE_HEADER]: this.sign(rawBody), 'content-type': 'application/json' } };
  }
}
