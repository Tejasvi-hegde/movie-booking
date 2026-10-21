import nodemailer from 'nodemailer';

/**
 * Strategy: each delivery channel is interchangeable. A channel is any object with
 * `name` and `send(message, eventId)` returning a promise.
 */

export class EmailChannel {
  name = 'email';

  constructor(host, port, from) {
    this.from = from;
    this.transporter = nodemailer.createTransport({ host, port, secure: false });
  }

  async send(message) {
    if (!message.emailWorthy || !message.email) return;
    await this.transporter.sendMail({
      from: this.from,
      to: message.email,
      subject: message.title,
      text: message.text,
      html: message.html || undefined,
    });
  }
}

export class ConsoleEmailChannel {
  name = 'console-email';
  constructor(logger) {
    this.logger = logger;
  }
  async send(message) {
    if (!message.emailWorthy || !message.email) return;
    this.logger.info({ to: message.email, subject: message.title, text: message.text }, '✉️  Email (console transport)');
  }
}

/** Last 50 messages per user in a Redis list, read by GET /notifications/me. */
export class InAppChannel {
  name = 'in-app';
  constructor(redis) {
    this.redis = redis;
  }

  static key(userId) {
    return `notif:inbox:${userId}`;
  }

  async send(message, eventId) {
    const item = { id: eventId, kind: message.kind, title: message.title, text: message.text, at: new Date().toISOString() };
    await this.redis
      .multi()
      .lpush(InAppChannel.key(message.userId), JSON.stringify(item))
      .ltrim(InAppChannel.key(message.userId), 0, 49)
      .expire(InAppChannel.key(message.userId), 30 * 86_400)
      .exec();
  }

  async list(userId) {
    const raw = await this.redis.lrange(InAppChannel.key(userId), 0, 49);
    return raw.map((r) => JSON.parse(r));
  }
}
