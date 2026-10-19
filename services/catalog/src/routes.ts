import { adminOnly, parse } from '@showtime/common';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { CatalogService } from './catalog-service.js';
import { SEAT_CATEGORIES, seatLayoutSchema } from './domain.js';

const movieSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  durationMins: z.number().int().min(30).max(300),
  languages: z.array(z.string().trim().min(1)).min(1),
  genres: z.array(z.string().trim().min(1)).min(1),
  certificate: z.enum(['U', 'UA', 'A']),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const venueSchema = z.object({
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().min(1).max(60),
  address: z.string().trim().min(1).max(300),
  timezone: z.string().optional(),
  screens: z.array(z.object({ name: z.string().trim().min(1).max(40), layout: seatLayoutSchema })).min(1).max(20),
});

const showSchema = z.object({
  movieId: z.string().min(1),
  venueId: z.string().min(1),
  screenId: z.string().min(1),
  startsAt: z.coerce.date(),
  /** Prices in paise per seat category. */
  prices: z.record(z.enum(SEAT_CATEGORIES), z.number().int().min(0).max(10_000_00)),
});

const sendCached = <T>(res: Response, result: { value: T; hit: boolean }) => {
  res.setHeader('X-Cache', result.hit ? 'HIT' : 'MISS');
  res.json(result.value);
};

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function catalogRoutes(catalog: CatalogService): Router {
  const r = Router();

  // ── public ──
  r.get('/cities', async (_req, res) => sendCached(res, await catalog.cities()));

  r.get('/movies', async (req, res) => {
    const q = parse(z.object({ city: z.string().max(60).optional(), q: z.string().max(100).optional() }), req.query);
    sendCached(res, await catalog.listMovies(q));
  });

  r.get('/movies/:id', async (req, res) => {
    res.json(await catalog.getMovie(req.params.id));
  });

  r.get('/movies/:id/showtimes', async (req, res) => {
    const q = parse(
      z.object({ city: z.string().min(1).max(60), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIst()) }),
      req.query,
    );
    sendCached(res, await catalog.showtimes(req.params.id, q.city, q.date));
  });

  r.get('/shows/:id', async (req, res) => {
    res.json(await catalog.getShow(req.params.id));
  });

  // ── admin ──
  r.get('/venues', adminOnly, async (req, res) => {
    res.json(await catalog.listVenues(typeof req.query.city === 'string' ? req.query.city : undefined));
  });
  r.get('/admin/shows', adminOnly, async (req, res) => {
    res.json(await catalog.listShowsForAdmin({ venueId: typeof req.query.venueId === 'string' ? req.query.venueId : undefined }));
  });
  r.post('/movies', adminOnly, async (req, res) => {
    res.status(201).json(await catalog.createMovie(parse(movieSchema, req.body)));
  });
  r.post('/venues', adminOnly, async (req, res) => {
    res.status(201).json(await catalog.createVenue(parse(venueSchema, req.body)));
  });
  r.post('/shows', adminOnly, async (req, res) => {
    res.status(201).json(await catalog.createShow(parse(showSchema, req.body)));
  });
  r.post('/shows/:id/cancel', adminOnly, async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200).default('Cancelled by venue') }), req.body ?? {});
    await catalog.cancelShow(String(req.params.id), reason);
    res.status(202).json({ status: 'CANCELLED' });
  });

  return r;
}
