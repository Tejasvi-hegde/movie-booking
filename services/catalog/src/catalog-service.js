import { randomUUID } from 'node:crypto';
import { BadRequestError, buildEvent, ConflictError, NotFoundError } from '@showtime/common';
import { categoriesIn, generateSeats, istDayRange, overlaps, showEndsAt } from './domain.js';

const movieDto = (m) => ({
  id: m._id,
  title: m.title,
  description: m.description,
  durationMins: m.durationMins,
  languages: m.languages,
  genres: m.genres,
  certificate: m.certificate,
  releaseDate: m.releaseDate,
});

const venueDto = (v) => ({
  id: v._id,
  name: v.name,
  city: v.city,
  address: v.address,
  timezone: v.timezone,
  screens: v.screens.map((s) => ({ id: s.screenId, name: s.name, layout: s.layout })),
});

const minPrice = (prices) => Math.min(...Object.values(prices).filter((p) => typeof p === 'number'));

export class CatalogService {
  constructor(db, cache, logger) {
    this.db = db;
    this.cache = cache;
    this.logger = logger;
  }

  // ── reads (cached) ───────────────────────────────────────────────────────────

  async cities() {
    return this.cache.getOrLoad('cities', async () => {
      const venues = await this.db.venues.find({}, { projection: { city: 1 } }).toArray();
      return [...new Set(venues.map((v) => v.city))].sort();
    });
  }

  async listMovies(filter) {
    return this.cache.getOrLoad(`movies:${filter.city ?? '*'}:${(filter.q ?? '').toLowerCase()}`, async () => {
      const query = {};
      if (filter.city) {
        // Only movies that actually have upcoming shows in this city.
        const shows = await this.db.shows
          .find({ city: filter.city, status: 'SCHEDULED', startsAt: { $gt: new Date() } }, { projection: { movieId: 1 } })
          .toArray();
        query._id = { $in: [...new Set(shows.map((s) => s.movieId))] };
      }
      if (filter.q) query.title = { $regex: escapeRegex(filter.q), $options: 'i' };
      const movies = await this.db.movies.find(query).sort({ releaseDate: -1 }).limit(100).toArray();
      return movies.map(movieDto);
    });
  }

  async getMovie(id) {
    const movie = await this.db.movies.findOne({ _id: id });
    if (!movie) throw new NotFoundError('Movie');
    return movieDto(movie);
  }

  /** Shows for a movie in a city on one day, grouped by venue — the "pick a showtime" screen. */
  async showtimes(movieId, city, date) {
    const { from, to } = istDayRange(date);
    return this.cache.getOrLoad(`showtimes:${movieId}:${city}:${date}`, async () => {
      const now = new Date();
      const shows = await this.db.shows
        .find(
          { movieId, city, status: 'SCHEDULED', startsAt: { $gte: from > now ? from : now, $lt: to } },
          { projection: { pendingEvents: 0 } },
        )
        .sort({ startsAt: 1 })
        .toArray();
      const venueIds = [...new Set(shows.map((s) => s.venueId))];
      const venues = await this.db.venues.find({ _id: { $in: venueIds } }).toArray();
      const byId = new Map(venues.map((v) => [v._id, v]));
      const groups = new Map();
      for (const s of shows) {
        const venue = byId.get(s.venueId);
        if (!venue) continue;
        const group = groups.get(venue._id) ?? { venue: { id: venue._id, name: venue.name, address: venue.address }, shows: [] };
        group.shows.push({
          id: s._id,
          startsAt: s.startsAt.toISOString(),
          screenName: venue.screens.find((sc) => sc.screenId === s.screenId)?.name ?? '',
          minPrice: minPrice(s.prices),
          prices: s.prices,
        });
        groups.set(venue._id, group);
      }
      return [...groups.values()].sort((a, b) => a.venue.name.localeCompare(b.venue.name));
    });
  }

  async getShow(id) {
    const show = await this.db.shows.findOne({ _id: id }, { projection: { pendingEvents: 0 } });
    if (!show) throw new NotFoundError('Show');
    const [movie, venue] = await Promise.all([
      this.db.movies.findOne({ _id: show.movieId }),
      this.db.venues.findOne({ _id: show.venueId }),
    ]);
    if (!movie || !venue) throw new NotFoundError('Show');
    const screen = venue.screens.find((s) => s.screenId === show.screenId);
    return {
      id: show._id,
      startsAt: show.startsAt.toISOString(),
      endsAt: show.endsAt.toISOString(),
      status: show.status,
      prices: show.prices,
      movie: movieDto(movie),
      venue: { id: venue._id, name: venue.name, city: venue.city, address: venue.address },
      screen: { id: screen?.screenId, name: screen?.name, layout: screen?.layout },
    };
  }

  async listVenues(city) {
    const venues = await this.db.venues
      .find(city ? { city } : {})
      .sort({ name: 1 })
      .toArray();
    return venues.map(venueDto);
  }

  async listShowsForAdmin(filter) {
    const query = { startsAt: { $gte: filter.from ?? new Date() } };
    if (filter.venueId) query.venueId = filter.venueId;
    const shows = await this.db.shows
      .find(query, { projection: { pendingEvents: 0 } })
      .sort({ startsAt: 1 })
      .limit(200)
      .toArray();
    const [movies, venues] = await Promise.all([
      this.db.movies.find({ _id: { $in: [...new Set(shows.map((s) => s.movieId))] } }).toArray(),
      this.db.venues.find({ _id: { $in: [...new Set(shows.map((s) => s.venueId))] } }).toArray(),
    ]);
    const m = new Map(movies.map((x) => [x._id, x.title]));
    const v = new Map(venues.map((x) => [x._id, x]));
    return shows.map((s) => ({
      id: s._id,
      movieTitle: m.get(s.movieId) ?? '?',
      venueName: v.get(s.venueId)?.name ?? '?',
      screenName: v.get(s.venueId)?.screens.find((sc) => sc.screenId === s.screenId)?.name ?? '?',
      city: s.city,
      startsAt: s.startsAt.toISOString(),
      status: s.status,
    }));
  }

  // ── writes (admin) ───────────────────────────────────────────────────────────

  async createMovie(input) {
    const doc = { _id: randomUUID(), ...input, createdAt: new Date() };
    await this.db.movies.insertOne(doc);
    await this.cache.invalidateAll();
    return movieDto(doc);
  }

  async createVenue(input) {
    const doc = {
      _id: randomUUID(),
      name: input.name,
      city: input.city,
      address: input.address,
      timezone: input.timezone ?? 'Asia/Kolkata',
      screens: input.screens.map((s) => {
        generateSeats(s.layout, Object.fromEntries(categoriesIn(s.layout).map((c) => [c, 0]))); // validates the layout
        return { screenId: randomUUID(), name: s.name, layout: s.layout };
      }),
      createdAt: new Date(),
    };
    await this.db.venues.insertOne(doc);
    await this.cache.invalidateAll();
    return venueDto(doc);
  }

  async createShow(input) {
    const [movie, venue] = await Promise.all([
      this.db.movies.findOne({ _id: input.movieId }),
      this.db.venues.findOne({ _id: input.venueId }),
    ]);
    if (!movie) throw new NotFoundError('Movie');
    if (!venue) throw new NotFoundError('Venue');
    const screen = venue.screens.find((s) => s.screenId === input.screenId);
    if (!screen) throw new NotFoundError('Screen');
    if (input.startsAt.getTime() < Date.now()) throw new BadRequestError('Show must start in the future');

    const endsAt = showEndsAt(input.startsAt, movie.durationMins);
    const neighbours = await this.db.shows
      .find(
        {
          venueId: venue._id,
          screenId: screen.screenId,
          status: 'SCHEDULED',
          startsAt: { $gte: new Date(input.startsAt.getTime() - 12 * 3_600_000), $lt: new Date(endsAt.getTime() + 12 * 3_600_000) },
        },
        { projection: { startsAt: 1, endsAt: 1 } },
      )
      .toArray();
    const clash = neighbours.find((s) => overlaps(input.startsAt, endsAt, s.startsAt, s.endsAt));
    if (clash) {
      throw new ConflictError('SCREEN_BUSY', 'Another show overlaps this time slot on the same screen', {
        showId: clash._id,
        startsAt: clash.startsAt,
      });
    }

    const seats = generateSeats(screen.layout, input.prices);
    const prices = Object.fromEntries(categoriesIn(screen.layout).map((c) => [c, input.prices[c]]));
    const showId = randomUUID();
    const event = buildEvent(
      'show.created',
      {
        showId,
        movieId: movie._id,
        movieTitle: movie.title,
        venueId: venue._id,
        venueName: venue.name,
        city: venue.city,
        screenId: screen.screenId,
        screenName: screen.name,
        startsAt: input.startsAt.toISOString(),
        timezone: venue.timezone,
        seats,
      },
      'catalog',
    );
    const doc = {
      _id: showId,
      movieId: movie._id,
      venueId: venue._id,
      screenId: screen.screenId,
      city: venue.city,
      startsAt: input.startsAt,
      endsAt,
      prices,
      status: 'SCHEDULED',
      pendingEvents: [event],
      hasPendingEvents: true,
      createdAt: new Date(),
    };
    await this.db.shows.insertOne(doc);
    await this.cache.invalidateAll();
    return { id: showId, startsAt: doc.startsAt.toISOString(), endsAt: endsAt.toISOString(), seats: seats.length };
  }

  /** Cancels a show; the booking service reacts by cancelling and refunding every booking for it. */
  async cancelShow(id, reason) {
    const event = buildEvent('show.cancelled', { showId: id, reason }, 'catalog');
    const res = await this.db.shows.updateOne(
      { _id: id, status: 'SCHEDULED' },
      { $set: { status: 'CANCELLED', hasPendingEvents: true }, $push: { pendingEvents: event } },
    );
    if (!res.matchedCount) {
      const exists = await this.db.shows.countDocuments({ _id: id });
      if (!exists) throw new NotFoundError('Show');
      throw new ConflictError('ALREADY_CANCELLED', 'Show is already cancelled');
    }
    await this.cache.invalidateAll();
    this.logger.info({ showId: id, reason }, 'Show cancelled');
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 100);
}
