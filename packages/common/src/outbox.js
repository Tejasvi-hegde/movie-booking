/**
 * Transactional outbox.
 *
 * Problem: "update the DB, then publish an event" is two writes to two systems. If the process
 * dies between them, the DB says CONFIRMED but nobody is ever told.
 *
 * Fix: write the event into an `outbox` table *in the same transaction* as the state change.
 * A relay publishes outbox rows to the stream afterwards. Delivery becomes at-least-once
 * (a crash after publish but before marking the row can re-send it), which is why every
 * consumer is idempotent.
 *
 * Expected table (created by each service's migrations):
 *   outbox(id UUID PK, seq BIGSERIAL, type TEXT, payload JSONB, created_at, published_at NULL)
 */
export async function enqueueEvent(db, event) {
  await db.query('INSERT INTO outbox (id, type, payload) VALUES ($1, $2, $3)', [event.id, event.type, JSON.stringify(event)]);
}

export class OutboxRelay {
  running = false;
  lastCleanup = 0;

  constructor(pool, publisher, logger, intervalMs = 250, batchSize = 100) {
    this.pool = pool;
    this.publisher = publisher;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
  }

  start() {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.kick();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.draining;
  }

  /** Drain now (called right after a commit to cut publish latency). Never runs two drains at once. */
  kick() {
    if (!this.draining) {
      this.draining = this.drainOnce()
        .catch((err) => {
          this.logger.error({ err }, 'Outbox drain failed');
          return 0;
        })
        .finally(() => {
          this.draining = undefined;
        });
    }
    return this.draining;
  }

  async drainOnce() {
    let total = 0;
    for (;;) {
      const client = await this.pool.connect();
      let published = 0;
      try {
        await client.query('BEGIN');
        // SKIP LOCKED lets several replicas relay concurrently without double-sending the same rows.
        const { rows } = await client.query(
          `SELECT id, payload FROM outbox
           WHERE published_at IS NULL
           ORDER BY seq
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        );
        const done = [];
        for (const row of rows) {
          await this.publisher.publish(row.payload);
          done.push(row.id);
        }
        if (done.length) {
          await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [done]);
        }
        await client.query('COMMIT');
        published = done.length;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      total += published;
      if (published < this.batchSize) break;
    }
    if (Date.now() - this.lastCleanup > 60 * 60_000) {
      this.lastCleanup = Date.now();
      await this.pool.query(`DELETE FROM outbox WHERE published_at < now() - interval '7 days'`);
    }
    return total;
  }
}
