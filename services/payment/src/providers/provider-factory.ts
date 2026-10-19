import { NotFoundError } from '@showtime/common';
import { MockPaymentProvider } from './mock-provider.js';
import type { PaymentProvider, ProviderName } from './provider.js';
import { RazorpayProvider } from './razorpay-provider.js';

export interface ProviderSettings {
  defaultProvider: ProviderName;
  mockWebhookSecret: string;
  razorpay?: { keyId: string; keySecret: string; webhookSecret: string };
}

/**
 * Factory: builds the configured providers once and hands out the right one by name.
 * Callers never `new` a provider or branch on provider type themselves.
 */
export class PaymentProviderFactory {
  private readonly providers = new Map<ProviderName, PaymentProvider>();

  constructor(private readonly settings: ProviderSettings) {
    this.providers.set('mock', new MockPaymentProvider(settings.mockWebhookSecret));
    if (settings.razorpay) {
      const r = settings.razorpay;
      this.providers.set('razorpay', new RazorpayProvider(r.keyId, r.keySecret, r.webhookSecret));
    }
    if (!this.providers.has(settings.defaultProvider)) {
      throw new Error(`PAYMENT_PROVIDER=${settings.defaultProvider} but it is not configured (missing keys?)`);
    }
  }

  get default(): PaymentProvider {
    return this.providers.get(this.settings.defaultProvider)!;
  }

  get(name: string): PaymentProvider {
    const provider = this.providers.get(name as ProviderName);
    if (!provider) throw new NotFoundError(`Payment provider "${name}"`);
    return provider;
  }

  get mock(): MockPaymentProvider {
    return this.providers.get('mock') as MockPaymentProvider;
  }
}
