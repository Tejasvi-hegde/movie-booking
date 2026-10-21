import { MongoClient } from 'mongodb';

/**
 * Collections and the shape of their documents. MongoDB does not enforce these; the API
 * validates input with zod before anything is written.
 *
 * movies  { _id, title, description, durationMins, languages[], genres[], certificate: 'U' | 'UA' | 'A', releaseDate, createdAt }
 * venues  { _id, name, city, address, timezone, createdAt,
 *           screens: [{ screenId, name, layout: { sections: [{ category, rows[], seatsPerRow, aisleAfter[] }] } }] }
 * shows   { _id, movieId, venueId, screenId, city, startsAt, endsAt, prices: { REGULAR?, PREMIUM?, RECLINER? },
 *           status: 'SCHEDULED' | 'CANCELLED', pendingEvents[], hasPendingEvents, createdAt }
 *
 * pendingEvents is an outbox embedded in the show document. MongoDB writes to a single document
 * are atomic, so the show and the event announcing it are saved together without a
 * multi-document transaction (which would need a replica set). event-relay.js publishes and
 * removes them.
 */
export async function connectMongo(url) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const db = client.db();
  const catalog = {
    client,
    db,
    movies: db.collection('movies'),
    venues: db.collection('venues'),
    shows: db.collection('shows'),
  };
  await Promise.all([
    catalog.shows.createIndex({ movieId: 1, city: 1, startsAt: 1 }),
    catalog.shows.createIndex({ venueId: 1, screenId: 1, startsAt: 1 }),
    catalog.shows.createIndex({ hasPendingEvents: 1 }),
    catalog.venues.createIndex({ city: 1 }),
  ]);
  return catalog;
}
