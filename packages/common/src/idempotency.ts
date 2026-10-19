import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type pg from 'pg';
import { BadRequestError, ConflictError, UnprocessableError } from './errors.js';
import { HEADERS } from './http.js';

/**
 * Stripe-style idempotency keys.
 *
 * A client sends `Idempotency-Key: <uuid>` on a non-idempotent POST. The first request with a key
 * runs normally and its response is stored. Any retry with the same key — after a timeout, a
 * double click, a flaky mobile network — gets the stored response replayed instead of running
 * the operation (charging, booking) a second time.
 *
 *  - same key + different body  → 422 (client bug: keys must not be reused for other requests)
 *  - same key while first in flight → 409 (retry shortly)
 *  - 5xx responses are not stored, so the client can safely retry them
 *
 * Expected table (created by each service's migrations):
 *   idempotency_keys(user_id TEXT, key TEXT, request_hash TEXT, status TEXT,
 *                    response_status INT, response_body JSONB, created_at TIMESTAMPTZ,
 *                    PRIMARY KEY (user_id, key))
 */
export function idempotent(pool: pg.Pool, { required = false } = {}): RequestHandler {
  return async (req, res, next) => {
    const key = req.header(HEADERS.idempotencyKey);
    if (!key) {
      if (required) return next(new BadRequestError('Idempotency-Key header is required for this endpoint'));
      return next();
    }
    if (key.length > 128) return next(new BadRequestError('Idempotency-Key must be at most 128 characters'));

    const userId = req.user?.id ?? 'anonymous';
    const requestHash = createHash('sha256')
      .update(`${req.method} ${req.baseUrl}${req.path}\n${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const inserted = await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, status)
       VALUES ($1, $2, $3, 'IN_PROGRESS')
       ON CONFLICT (user_id, key) DO UPDATE
         SET created_at = now(), request_hash = EXCLUDED.request_hash
         WHERE idempotency_keys.status = 'IN_PROGRESS'
           AND idempotency_keys.created_at < now() - interval '60 seconds'  -- take over an abandoned attempt
       RETURNING key`,
      [userId, key, requestHash],
    );

    if (!inserted.rowCount) {
      const { rows } = await pool.query<{ request_hash: string; status: string; response_status: number; response_body: unknown }>(
        'SELECT request_hash, status, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      );
      const row = rows[0];
      if (!row) return next(new ConflictError('IDEMPOTENCY_RETRY', 'Please retry the request'));
      if (row.request_hash !== requestHash) {
        return next(new UnprocessableError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request'));
      }
      if (row.status === 'IN_PROGRESS') {
        return next(new ConflictError('REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed'));
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(row.response_status).json(row.response_body);
      return;
    }

    let body: unknown;
    const originalJson = res.json.bind(res);
    res.json = (payload: unknown) => {
      body = payload;
      return originalJson(payload);
    };
    res.on('finish', () => {
      const done =
        res.statusCode >= 500
          ? pool.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key])
          : pool.query(
              `UPDATE idempotency_keys SET status = 'COMPLETED', response_status = $3, response_body = $4
               WHERE user_id = $1 AND key = $2`,
              [userId, key, res.statusCode, JSON.stringify(body ?? null)],
            );
      done.catch((err) => req.log?.error({ err }, 'Failed to persist idempotency result'));
    });
    next();
  };
}

export async function cleanupIdempotencyKeys(pool: pg.Pool, olderThanHours = 24): Promise<void> {
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [olderThanHours]);
}
