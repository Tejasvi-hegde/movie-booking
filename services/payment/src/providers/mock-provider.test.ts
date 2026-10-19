import { describe, expect, it } from 'vitest';
import { MockPaymentProvider } from './mock-provider.js';

describe('MockPaymentProvider webhooks', () => {
  const provider = new MockPaymentProvider('test-secret');

  it('produces webhooks that pass its own signature check', () => {
    const { rawBody, headers } = provider.simulate('order_1', 'success');
    expect(provider.verifyWebhook(rawBody, headers)).toBe(true);
    expect(provider.parseWebhook(JSON.parse(rawBody.toString()))).toMatchObject({ type: 'payment.captured', providerOrderId: 'order_1' });
  });

  it('rejects a tampered body', () => {
    const { rawBody, headers } = provider.simulate('order_1', 'success');
    const tampered = Buffer.from(rawBody.toString().replace('order_1', 'order_2'));
    expect(provider.verifyWebhook(tampered, headers)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    const { rawBody, headers } = new MockPaymentProvider('attacker-secret').simulate('order_1', 'success');
    expect(provider.verifyWebhook(rawBody, headers)).toBe(false);
  });

  it('rejects a missing signature', () => {
    const { rawBody } = provider.simulate('order_1', 'failure');
    expect(provider.verifyWebhook(rawBody, {})).toBe(false);
  });

  it('carries the decline reason on failures', () => {
    const { rawBody } = provider.simulate('order_9', 'failure');
    expect(provider.parseWebhook(JSON.parse(rawBody.toString()))).toMatchObject({ type: 'payment.failed', reason: expect.stringContaining('declined') });
  });
});
