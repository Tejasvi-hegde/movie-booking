import type { Logger, Redis } from '@showtime/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Message } from './templates.js';

/** Strategy: each delivery channel is interchangeable behind one interface. */
export interface NotificationChannel {
  readonly name: string;
  send(message: Message, eventId: string): Promise<void>;
}

export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  private readonly transporter: Transporter;

  constructor(host: string, port: number, private readonly from: string) {
    this.transporter = nodemailer.createTransport({ host, port, secure: false });
  }

  async send(message: Message): Promise<void> {
    if (!message.emailWorthy || !message.email) return;
    await this.transporter.sendMail({ from: this.from, to: message.email, subject: message.title, text: message.text, html: message.html || undefined });
  }
}

export class ConsoleEmailChannel implements NotificationChannel {
  readonly name = 'console-email';
  constructor(private readonly logger: Logger) {}
  async send(message: Message): Promise<void> {
    if (!message.emailWorthy || !message.email) return;
    this.logger.info({ to: message.email, subject: message.title, text: message.text }, '✉️  Email (console transport)');
  }
}

/** Last 50 messages per user in a Redis list, read by GET /notifications/me. */
export class InAppChannel implements NotificationChannel {
  readonly name = 'in-app';
  constructor(private readonly redis: Redis) {}

  static key(userId: string): string {
    return `notif:inbox:${userId}`;
  }

  async send(message: Message, eventId: string): Promise<void> {
    const item = { id: eventId, kind: message.kind, title: message.title, text: message.text, at: new Date().toISOString() };
    await this.redis
      .multi()
      .lpush(InAppChannel.key(message.userId), JSON.stringify(item))
      .ltrim(InAppChannel.key(message.userId), 0, 49)
      .expire(InAppChannel.key(message.userId), 30 * 86_400)
      .exec();
  }

  async list(userId: string) {
    const raw = await this.redis.lrange(InAppChannel.key(userId), 0, 49);
    return raw.map((r) => JSON.parse(r) as { id: string; kind: string; title: string; text: string; at: string });
  }
}
