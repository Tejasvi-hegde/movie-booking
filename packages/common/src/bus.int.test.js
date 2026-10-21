import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildEvent, EventConsumer, EventPublisher } from './bus.js';
import { TOPICS } from './events.js';
import { createLogger } from './logger.js';

// Own Redis database (14): this file calls flushdb(), which must never touch another test file's data.
const REDIS_URL = process.env.TEST_BUS_REDIS_URL ?? 'redis://localhost:6379/14';
const logger = createLogger('test', 'silent');
const redis = new Redis(REDIS_URL);
const publisher = new EventPublisher(redis);
const consumers = [];

const waitUntil = async (cond, ms = 5000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const consumer = (group, opts = {}) => {
  const c = new EventConsumer({ redis: redis.duplicate(), group, consumer: randomUUID(), logger, blockMs: 100, claimIdleMs: 300, ...opts });
  consumers.push(c);
  return c;
};

const payment = () => buildEvent('payment.failed', { paymentId: randomUUID(), bookingId: randomUUID(), userId: 'u', reason: 'x' }, 'test');

beforeEach(async () => {
  for (const c of consumers.splice(0)) await c.stop();
  await redis.flushdb();
});
afterAll(async () => {
  for (const c of consumers) await c.stop();
  await redis.quit();
});

describe('Redis Streams event bus', () => {
  it('delivers every event once to each consumer group', async () => {
    const a = [];
    const b = [];
    await consumer('group-a')
      .on('payment.failed', async (e) => void a.push(e.id))
      .start();
    await consumer('group-b')
      .on('payment.failed', async (e) => void b.push(e.id))
      .start();
    const events = [payment(), payment(), payment()];
    for (const e of events) await publisher.publish(e);
    await waitUntil(() => a.length === 3 && b.length === 3);
    expect(a).toEqual(events.map((e) => e.id));
    expect(b).toEqual(events.map((e) => e.id));
  });

  it('a new group still receives events published before it existed', async () => {
    const e = payment();
    await publisher.publish(e);
    const got = [];
    await consumer('late-group')
      .on('payment.failed', async (ev) => void got.push(ev.id))
      .start();
    await waitUntil(() => got.length === 1);
    expect(got).toEqual([e.id]);
  });

  it('retries a failing handler until it succeeds', async () => {
    let attempts = 0;
    await consumer('retry')
      .on('payment.failed', async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
      })
      .start();
    await publisher.publish(payment());
    await waitUntil(() => attempts === 3);
    await waitUntil(async () => (await redis.xpending(TOPICS.payment, 'retry'))[0] === 0);
  });

  it('moves a poison message to the dead-letter queue after max deliveries', async () => {
    let attempts = 0;
    await consumer('dlq', { maxDeliveries: 3 })
      .on('payment.failed', async () => {
        attempts++;
        throw new Error('always broken');
      })
      .start();
    const e = payment();
    await publisher.publish(e);
    await waitUntil(async () => (await redis.xlen(`dlq:${TOPICS.payment}:dlq`)) === 1, 8000);
    const entries = await redis.xrange(`dlq:${TOPICS.payment}:dlq`, '-', '+');
    const fields = entries[0][1];
    expect(fields).toContain('payment.failed');
    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});
