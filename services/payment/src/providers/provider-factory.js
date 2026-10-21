import { NotFoundError } from '@showtime/common';
import { MockPaymentProvider } from './mock-provider.js';
import { RazorpayProvider } from './razorpay-provider.js';

/**
 * Factory: builds the configured providers once and hands out the right one by name.
 * Callers never `new` a provider or branch on provider type themselves.
 */
export class PaymentProviderFactory {
  providers = new Map();

  constructor(settings) {
    this.settings = settings;
    this.providers.set('mock', new MockPaymentProvider(settings.mockWebhookSecret));
    if (settings.razorpay) {
      const r = settings.razorpay;
      this.providers.set('razorpay', new RazorpayProvider(r.keyId, r.keySecret, r.webhookSecret));
    }
    if (!this.providers.has(settings.defaultProvider)) {
      throw new Error(`PAYMENT_PROVIDER=${settings.defaultProvider} but it is not configured (missing keys?)`);
    }
  }

  get default() {
    return this.providers.get(this.settings.defaultProvider);
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) throw new NotFoundError(`Payment provider "${name}"`);
    return provider;
  }

  get mock() {
    return this.providers.get('mock');
  }
}
