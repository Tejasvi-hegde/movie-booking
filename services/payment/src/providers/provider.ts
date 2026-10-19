import type { IncomingHttpHeaders } from 'node:http';

export type ProviderName = 'mock' | 'razorpay';

export interface CreateOrderInput {
  paymentId: string;
  amount: number;
  currency: string;
}

export interface CreateOrderResult {
  providerOrderId: string;
  /** Whatever the frontend needs to open this provider's checkout. */
  checkout: Record<string, unknown>;
}

export interface ProviderEvent {
  /** Provider's unique id for this notification — the de-duplication key. */
  eventId: string;
  type: 'payment.captured' | 'payment.failed';
  providerOrderId: string;
  providerPaymentId?: string;
  reason?: string;
}

/**
 * Every payment gateway looks different (APIs, signatures, payload shapes). The rest of the
 * service only talks to this interface, so supporting Stripe or PayU later means adding one
 * class and one line in the factory — nothing else changes.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** Verifies the webhook really came from the provider (HMAC over the raw body). */
  verifyWebhook(rawBody: Buffer, headers: IncomingHttpHeaders): boolean;
  /** Normalises a webhook into our event shape; null for event types we ignore. */
  parseWebhook(body: unknown, headers: IncomingHttpHeaders): ProviderEvent | null;
  refund(input: { providerPaymentId: string; amount: number; paymentId: string }): Promise<{ refundId: string }>;
}

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
