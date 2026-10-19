import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { header, type CreateOrderInput, type CreateOrderResult, type PaymentProvider, type ProviderEvent } from './provider.js';

const SIGNATURE_HEADER = 'x-mock-signature';

interface MockWebhookBody {
  id: string;
  event: 'payment.captured' | 'payment.failed';
  payload: { order_id: string; payment_id: string; error?: string };
}

/**
 * A fake gateway that behaves like a real one: orders, HMAC-signed webhooks, refunds.
 * `simulate()` produces exactly the signed webhook a real provider would send, and it goes
 * through the same verification + processing code as a real webhook.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  constructor(private readonly webhookSecret: string) {}

  async createOrder(_input: CreateOrderInput): Promise<CreateOrderResult> {
    const providerOrderId = `order_mock_${randomBytes(8).toString('hex')}`;
    return { providerOrderId, checkout: { mode: 'mock', orderId: providerOrderId } };
  }

  sign(rawBody: Buffer | string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
    const given = header(headers, SIGNATURE_HEADER);
    if (!given) return false;
    const expected = Buffer.from(this.sign(rawBody));
    const actual = Buffer.from(given);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  parseWebhook(body: unknown): ProviderEvent | null {
    const b = body as MockWebhookBody;
    if (!b?.id || !b.payload?.order_id) return null;
    if (b.event !== 'payment.captured' && b.event !== 'payment.failed') return null;
    return { eventId: b.id, type: b.event, providerOrderId: b.payload.order_id, providerPaymentId: b.payload.payment_id, reason: b.payload.error };
  }

  async refund(_input: { providerPaymentId: string; amount: number }): Promise<{ refundId: string }> {
    return { refundId: `rfnd_mock_${randomBytes(8).toString('hex')}` };
  }

  /** Builds the signed webhook the "gateway" would send for this order. */
  simulate(providerOrderId: string, outcome: 'success' | 'failure'): { rawBody: Buffer; headers: IncomingHttpHeaders } {
    const body: MockWebhookBody = {
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
