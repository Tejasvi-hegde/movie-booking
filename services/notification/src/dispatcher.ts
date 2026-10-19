import type { AnyEvent, Logger, Redis } from '@showtime/common';
import type { NotificationChannel } from './channels.js';
import { render } from './templates.js';

/**
 * Observer side of the system: reacts to domain events from other services and fans each one
 * out to every channel.
 *
 * Events arrive at-least-once, but users must not get the same email twice. A Redis key per
 * event id is claimed (SET NX) before sending and released again if sending fails, so a
 * retry can try once more.
 */
export class NotificationDispatcher {
  constructor(
    private readonly redis: Redis,
    private readonly channels: NotificationChannel[],
    private readonly logger: Logger,
  ) {}

  async handle(event: AnyEvent): Promise<void> {
    const message = render(event);
    if (!message) return;

    const claimKey = `notif:sent:${event.id}`;
    const claimed = await this.redis.set(claimKey, '1', 'EX', 7 * 86_400, 'NX');
    if (!claimed) {
      this.logger.debug({ eventId: event.id }, 'Duplicate event, notification already sent');
      return;
    }
    try {
      for (const channel of this.channels) await channel.send(message, event.id);
      this.logger.info({ eventId: event.id, type: event.type, userId: message.userId }, 'Notification sent');
    } catch (err) {
      await this.redis.del(claimKey);
      throw err;
    }
  }
}
