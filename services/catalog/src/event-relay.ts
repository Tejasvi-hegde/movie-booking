import type { EventPublisher, Logger } from '@showtime/common';
import type { CatalogDb } from './db.js';

/**
 * Publishes events stored inside show documents (see ShowDoc.pendingEvents) and removes them.
 * At-least-once: if we crash after publishing but before the $pull, the event is sent again
 * and the booking service's idempotent handlers ignore the duplicate.
 */
export class ShowEventRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private busy = false;

  constructor(
    private readonly db: CatalogDb,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly intervalMs = 500,
  ) {}

  start(): void {
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      await this.drain();
      this.timer = setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async drain(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let count = 0;
    try {
      const docs = await this.db.shows.find({ hasPendingEvents: true }, { projection: { pendingEvents: 1 } }).limit(100).toArray();
      for (const doc of docs) {
        const ids: string[] = [];
        for (const event of doc.pendingEvents ?? []) {
          await this.publisher.publish(event);
          ids.push(event.id);
        }
        await this.db.shows.updateOne({ _id: doc._id }, { $pull: { pendingEvents: { id: { $in: ids } } } });
        // Only clear the flag if nothing new was pushed meanwhile.
        await this.db.shows.updateOne({ _id: doc._id, pendingEvents: { $size: 0 } }, { $set: { hasPendingEvents: false } });
        count += ids.length;
      }
    } catch (err) {
      this.logger.error({ err }, 'Show event relay failed');
    } finally {
      this.busy = false;
    }
    return count;
  }
}
