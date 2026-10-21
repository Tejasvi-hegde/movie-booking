/**
 * Every payment gateway looks different (APIs, signatures, payload shapes). The rest of the
 * service only talks to providers through the methods below, so supporting Stripe or PayU later
 * means adding one class and one line in the factory — nothing else changes.
 *
 * A provider is an object with:
 *   name                                            'mock' | 'razorpay'
 *   createOrder({ paymentId, amount, currency })    → { providerOrderId, checkout }
 *       checkout = whatever the frontend needs to open this provider's checkout
 *   verifyWebhook(rawBody, headers)                 → true if the HMAC signature over the raw body is valid
 *   parseWebhook(body, headers)                     → ProviderEvent, or null for event types we ignore
 *   refund({ providerPaymentId, amount, paymentId }) → { refundId }
 *
 * @typedef {object} ProviderEvent
 * @property {string} eventId            provider's unique id for this notification (the de-duplication key)
 * @property {'payment.captured' | 'payment.failed'} type
 * @property {string} providerOrderId
 * @property {string} [providerPaymentId]
 * @property {string} [reason]
 */

/** Reads one header value (Node gives an array for repeated headers). */
export function header(headers, name) {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
