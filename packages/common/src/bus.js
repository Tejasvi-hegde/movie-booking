import { randomUUID } from 'node:crypto';
import { EVENT_TOPIC } from './events.js';
import { counter } from './metrics.js';

const consumed = counter('events_consumed_total', 'Events handled by consumers', ['group', 'type', 'outcome']);

export function buildEvent(type, data, source) {
  return { id: randomUUID(), type, source, occurredAt: new Date().toISOString(), version: 1, data };
}

/**
 * Publishes events to Redis Streams (one stream per topic).
 * Services that own a Postgres database never call this directly from request handlers —
 * they write to the outbox table and let the OutboxRelay publish (see outbox.js).
 */
export class EventPublisher {
  constructor(redis, maxLen = 100_000) {
    this.redis = redis;
    this.maxLen = maxLen;
  }

  async publish(event) {
    const topic = EVENT_TOPIC[event.type];
    if (!topic) throw new Error(`Unknown event type: ${event.type}`);
    const id = await this.redis.xadd(topic, 'MAXLEN', '~', this.maxLen, '*', 'type', event.type, 'event', JSON.stringify(event));
    return id;
  }
}

/**
 * Redis Streams consumer-group worker.
 *
 *  - At-least-once: a message is acknowledged only after its handler succeeds.
 *  - Retries: failed or orphaned messages are re-claimed after `claimIdleMs`.
 *  - Dead-letter queue: after `maxDeliveries` attempts the message moves to `dlq:<topic>:<group>`
 *    so one poison message cannot block the stream forever.
 */
export class EventConsumer {
  handlers = new Map();
  running = false;
  loops = [];

  /**
   * @param {object} opts
   * @param {import('ioredis').Redis} opts.redis  dedicated connection: XREADGROUP BLOCK holds it while waiting
   * @param {string} opts.group      consumer group, normally the service name; each group gets every event once
   * @param {string} opts.consumer   unique per replica (hostname-pid)
   * @param {object} opts.logger
   * @param {number} [opts.maxDeliveries=5]  after this many attempts the message goes to the dead-letter stream
   * @param {number} [opts.claimIdleMs=15000] a message unacknowledged this long is assumed lost and retried
   * @param {number} [opts.blockMs=2000]
   * @param {number} [opts.batchSize=20]
   */
  constructor(opts) {
    this.opts = opts;
    this.maxDeliveries = opts.maxDeliveries ?? 5;
    this.claimIdleMs = opts.claimIdleMs ?? 15_000;
    this.blockMs = opts.blockMs ?? 2_000;
    this.batchSize = opts.batchSize ?? 20;
  }

  on(type, handler) {
    this.handlers.set(type, handler);
    return this;
  }

  get topics() {
    return [...new Set([...this.handlers.keys()].map((t) => EVENT_TOPIC[t]))];
  }

  async start() {
    const { redis, group } = this.opts;
    for (const topic of this.topics) {
      try {
        // '0' = a brand-new group starts from the beginning of the stream, so events published
        // before this service was first deployed are not lost.
        await redis.xgroup('CREATE', topic, group, '0', 'MKSTREAM');
      } catch (err) {
        if (!String(err.message).includes('BUSYGROUP')) throw err;
      }
    }
    this.running = true;
    this.loops = [this.readLoop(), this.reclaimLoop()];
    this.opts.logger.info({ group, topics: this.topics, types: [...this.handlers.keys()] }, 'Event consumer started');
  }

  async stop() {
    this.running = false;
    await Promise.allSettled(this.loops);
  }

  async readLoop() {
    const { redis, group, consumer, logger } = this.opts;
    const topics = this.topics;
    while (this.running) {
      try {
        const res = await redis.xreadgroup(
          'GROUP',
          group,
          consumer,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          ...topics,
          ...topics.map(() => '>'),
        );
        if (!res) continue;
        for (const [topic, messages] of res) {
          for (const [id, fields] of messages) await this.process(topic, id, fields);
        }
      } catch (err) {
        if (!this.running) break;
        logger.error({ err }, 'Stream read failed, backing off');
        await sleep(1_000);
      }
    }
  }

  async reclaimLoop() {
    const { redis, group, consumer, logger } = this.opts;
    const interval = Math.max(250, Math.floor(this.claimIdleMs / 2));
    while (this.running) {
      await sleep(interval);
      if (!this.running) break;
      for (const topic of this.topics) {
        try {
          const pending = await redis.xpending(topic, group, 'IDLE', this.claimIdleMs, '-', '+', 50);
          for (const [id, , , deliveries] of pending) {
            if (deliveries >= this.maxDeliveries) {
              await this.deadLetter(topic, id, deliveries);
              continue;
            }
            const claimed = await redis.xclaim(topic, group, consumer, this.claimIdleMs, id);
            for (const [cid, fields] of claimed) {
              if (fields) await this.process(topic, cid, fields);
            }
          }
        } catch (err) {
          if (this.running) logger.error({ err, topic }, 'Reclaim pass failed');
        }
      }
    }
  }

  async deadLetter(topic, id, deliveries) {
    const { redis, group, logger } = this.opts;
    const [entry] = await redis.xrange(topic, id, id);
    const fields = entry?.[1] ?? [];
    await redis.xadd(`dlq:${topic}:${group}`, '*', 'originalId', id, 'deliveries', String(deliveries), ...fields);
    await redis.xack(topic, group, id);
    logger.error({ topic, id, deliveries, type: field(fields, 'type') }, 'Message moved to dead-letter queue');
    consumed.inc({ group, type: field(fields, 'type') ?? 'unknown', outcome: 'dead_lettered' });
  }

  async process(topic, id, fields) {
    const { redis, group, logger } = this.opts;
    const type = field(fields, 'type');
    const handler = type ? this.handlers.get(type) : undefined;
    if (!handler) {
      // This group does not care about this event type (topics carry several types).
      await redis.xack(topic, group, id);
      return;
    }
    let event;
    try {
      event = JSON.parse(field(fields, 'event') ?? '');
    } catch {
      logger.error({ topic, id }, 'Unparseable event, acknowledging to skip');
      await redis.xack(topic, group, id);
      return;
    }
    const log = logger.child({ eventId: event.id, type, streamId: id });
    try {
      await handler(event);
      await redis.xack(topic, group, id);
      consumed.inc({ group, type: type, outcome: 'ok' });
      log.debug('Event handled');
    } catch (err) {
      consumed.inc({ group, type: type, outcome: 'error' });
      log.error({ err }, 'Event handler failed; will retry after idle timeout');
    }
  }
}

function field(fields, name) {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
