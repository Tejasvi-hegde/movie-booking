import { adminOnly, idempotent, parse, requireUser } from '@showtime/common';
import { Router } from 'express';
import { z } from 'zod';
import { COUPONS } from './domain/pricing.js';

const seatSelection = z.object({
  showId: z.string().min(1).max(64),
  seatIds: z.array(z.string().min(1).max(8)).min(1).max(20),
  couponCode: z.string().trim().max(32).optional(),
});

export function bookingRoutes(bookings, seatEvents, pool) {
  const r = Router();

  // Public seat map; signed-in users also see which held seats are theirs.
  r.get('/shows/:showId/seats', async (req, res) => {
    res.json(await bookings.seatMap(req.params.showId, req.user?.id));
  });

  // Live updates (Server-Sent Events).
  r.get('/shows/:showId/stream', (req, res) => {
    seatEvents.subscribe(req.params.showId, res);
  });

  r.get('/coupons', (_req, res) => {
    res.json(COUPONS.map((c) => ({ code: c.code, description: c.description })));
  });

  r.post('/quote', async (req, res) => {
    res.json(await bookings.quote(parse(seatSelection, req.body)));
  });

  // Idempotency-Key is optional here: a retried hold replays the first response instead of
  // cancelling the first hold and creating a second one.
  r.post('/holds', idempotent(pool), async (req, res) => {
    const user = requireUser(req);
    res.status(201).json(await bookings.hold(user, parse(seatSelection, req.body)));
  });

  r.get('/me', async (req, res) => {
    res.json(await bookings.listForUser(requireUser(req)));
  });

  r.get('/admin/stats', adminOnly, async (_req, res) => {
    res.json(await bookings.stats());
  });

  r.get('/:id', async (req, res) => {
    res.json(await bookings.getForUser(requireUser(req), req.params.id));
  });

  r.post('/:id/cancel', async (req, res) => {
    res.json(await bookings.cancel(requireUser(req), req.params.id));
  });

  return r;
}

/** Service-to-service endpoints. Not routed by the gateway (it only exposes /bookings/*). */
export function internalRoutes(bookings) {
  const r = Router();
  r.get('/bookings/:id', async (req, res) => {
    res.json(await bookings.getForPayment(req.params.id));
  });
  return r;
}
