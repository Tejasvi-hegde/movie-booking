const CHANNEL_PREFIX = 'seats:';

/**
 * Live seat-map updates over Server-Sent Events.
 *
 * Any replica that changes seats publishes to Redis pub/sub; every replica relays the message
 * to the browsers connected to *it*. This is what lets SSE scale horizontally: clients can be
 * connected to any instance and still see changes made on another one.
 */
export class SeatEventHub {
  clients = new Map();

  constructor(publisherRedis, subscriberRedis, logger) {
    this.publisherRedis = publisherRedis;
    this.subscriberRedis = subscriberRedis;
    this.logger = logger;
  }

  async start() {
    await this.subscriberRedis.psubscribe(`${CHANNEL_PREFIX}*`);
    this.subscriberRedis.on('pmessage', (_pattern, channel, message) => {
      const showId = channel.slice(CHANNEL_PREFIX.length);
      for (const res of this.clients.get(showId) ?? []) res.write(`event: seats\ndata: ${message}\n\n`);
    });
    // Comment lines keep proxies/load balancers from closing idle connections.
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const res of set) res.write(': ping\n\n');
    }, 15_000);
  }

  async stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.clients.values()) for (const res of set) res.end();
    this.clients.clear();
    await this.subscriberRedis.quit().catch(() => undefined);
  }

  subscribe(showId, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });
    res.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
    const set = this.clients.get(showId) ?? new Set();
    set.add(res);
    this.clients.set(showId, set);
    res.on('close', () => {
      set.delete(res);
      if (!set.size) this.clients.delete(showId);
    });
  }

  /** Fire-and-forget: a missed update is corrected by the client's periodic refresh. */
  notify(showId, change) {
    this.publisherRedis
      .publish(`${CHANNEL_PREFIX}${showId}`, JSON.stringify({ showId, ...change, at: Date.now() }))
      .catch((err) => this.logger.warn({ err: err.message }, 'Seat update publish failed'));
  }

  get connectionCount() {
    let n = 0;
    for (const set of this.clients.values()) n += set.size;
    return n;
  }
}
