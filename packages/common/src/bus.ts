import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { EVENT_TOPIC, type AnyEvent, type EventEnvelope, type EventMap, type EventType, type Topic } from './events.js';
import type { Logger } from './logger.js';
import { counter } from './metrics.js';

const consumed = counter('events_consumed_total', 'Events handled by consumers', ['group', 'type', 'outcome']);

export function buildEvent<T extends EventType>(type: T, data: EventMap[T], source: string): EventEnvelope<T, EventMap[T]> {
  return { id: randomUUID(), type, source, occurredAt: new Date().toISOString(), version: 1, data };
}

/**
 * Publishes events to Redis Streams (one stream per topic).
 * Services that own a Postgres database never call this directly from request handlers —
 * they write to the outbox table and let the OutboxRelay publish (see outbox.ts).
 */
export class EventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly maxLen = 100_000,
  ) {}

  async publish(event: EventEnvelope): Promise<string> {
    const topic = EVENT_TOPIC[event.type as EventType];
    if (!topic) throw new Error(`Unknown event type: ${event.type}`);
    const id = await this.redis.xadd(topic, 'MAXLEN', '~', this.maxLen, '*', 'type', event.type, 'event', JSON.stringify(event));
    return id as string;
  }
}

type Handler<T extends EventType> = (event: EventEnvelope<T, EventMap[T]>) => Promise<void>;

export interface ConsumerOptions {
  /** Dedicated connection — XREADGROUP BLOCK holds the connection while waiting. */
  redis: Redis;
  /** Consumer group, normally the service name. Each group gets every event once. */
  group: string;
  /** Unique per replica (hostname/pid). */
  consumer: string;
  logger: Logger;
  maxDeliveries?: number;
  /** A message unacknowledged for this long is assumed lost (crashed consumer / failed handler) and retried. */
  claimIdleMs?: number;
  blockMs?: number;
  batchSize?: number;
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
  private readonly handlers = new Map<string, Handler<EventType>>();
  private running = false;
  private loops: Promise<void>[] = [];
  private readonly maxDeliveries: number;
  private readonly claimIdleMs: number;
  private readonly blockMs: number;
  private readonly batchSize: number;

  constructor(private readonly opts: ConsumerOptions) {
    this.maxDeliveries = opts.maxDeliveries ?? 5;
    this.claimIdleMs = opts.claimIdleMs ?? 15_000;
    this.blockMs = opts.blockMs ?? 2_000;
    this.batchSize = opts.batchSize ?? 20;
  }

  on<T extends EventType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as Handler<EventType>);
    return this;
  }

  private get topics(): Topic[] {
    return [...new Set([...this.handlers.keys()].map((t) => EVENT_TOPIC[t as EventType]))];
  }

  async start(): Promise<void> {
    const { redis, group } = this.opts;
    for (const topic of this.topics) {
      try {
        // '0' = a brand-new group starts from the beginning of the stream, so events published
        // before this service was first deployed are not lost.
        await redis.xgroup('CREATE', topic, group, '0', 'MKSTREAM');
      } catch (err) {
        if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
      }
    }
    this.running = true;
    this.loops = [this.readLoop(), this.reclaimLoop()];
    this.opts.logger.info({ group, topics: this.topics, types: [...this.handlers.keys()] }, 'Event consumer started');
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
  }

  private async readLoop(): Promise<void> {
    const { redis, group, consumer, logger } = this.opts;
    const topics = this.topics;
    while (this.running) {
      try {
        const res = (await redis.xreadgroup(
          'GROUP', group, consumer,
          'COUNT', this.batchSize,
          'BLOCK', this.blockMs,
          'STREAMS', ...topics, ...topics.map(() => '>'),
        )) as [string, [string, string[]][]][] | null;
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

  private async reclaimLoop(): Promise<void> {
    const { redis, group, consumer, logger } = this.opts;
    const interval = Math.max(250, Math.floor(this.claimIdleMs / 2));
    while (this.running) {
      await sleep(interval);
      if (!this.running) break;
      for (const topic of this.topics) {
        try {
          const pending = (await redis.xpending(topic, group, 'IDLE', this.claimIdleMs, '-', '+', 50)) as [string, string, number, number][];
          for (const [id, , , deliveries] of pending) {
            if (deliveries >= this.maxDeliveries) {
              await this.deadLetter(topic, id, deliveries);
              continue;
            }
            const claimed = (await redis.xclaim(topic, group, consumer, this.claimIdleMs, id)) as [string, string[]][];
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

  private async deadLetter(topic: string, id: string, deliveries: number): Promise<void> {
    const { redis, group, logger } = this.opts;
    const [entry] = (await redis.xrange(topic, id, id)) as [string, string[]][];
    const fields = entry?.[1] ?? [];
    await redis.xadd(`dlq:${topic}:${group}`, '*', 'originalId', id, 'deliveries', String(deliveries), ...fields);
    await redis.xack(topic, group, id);
    logger.error({ topic, id, deliveries, type: field(fields, 'type') }, 'Message moved to dead-letter queue');
    consumed.inc({ group, type: field(fields, 'type') ?? 'unknown', outcome: 'dead_lettered' });
  }

  private async process(topic: string, id: string, fields: string[]): Promise<void> {
    const { redis, group, logger } = this.opts;
    const type = field(fields, 'type');
    const handler = type ? this.handlers.get(type) : undefined;
    if (!handler) {
      // This group does not care about this event type (topics carry several types).
      await redis.xack(topic, group, id);
      return;
    }
    let event: AnyEvent;
    try {
      event = JSON.parse(field(fields, 'event') ?? '') as AnyEvent;
    } catch {
      logger.error({ topic, id }, 'Unparseable event, acknowledging to skip');
      await redis.xack(topic, group, id);
      return;
    }
    const log = logger.child({ eventId: event.id, type, streamId: id });
    try {
      await handler(event as never);
      await redis.xack(topic, group, id);
      consumed.inc({ group, type: type!, outcome: 'ok' });
      log.debug('Event handled');
    } catch (err) {
      consumed.inc({ group, type: type!, outcome: 'error' });
      log.error({ err }, 'Event handler failed; will retry after idle timeout');
    }
  }
}

function field(fields: string[], name: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
