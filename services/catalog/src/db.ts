import type { EventEnvelope } from '@showtime/common';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { CategoryPrices, SeatLayout } from './domain.js';

export interface MovieDoc {
  _id: string;
  title: string;
  description: string;
  durationMins: number;
  languages: string[];
  genres: string[];
  certificate: 'U' | 'UA' | 'A';
  releaseDate: string;
  createdAt: Date;
}

export interface ScreenDoc {
  screenId: string;
  name: string;
  layout: SeatLayout;
}

export interface VenueDoc {
  _id: string;
  name: string;
  city: string;
  address: string;
  timezone: string;
  screens: ScreenDoc[];
  createdAt: Date;
}

export type ShowStatus = 'SCHEDULED' | 'CANCELLED';

export interface ShowDoc {
  _id: string;
  movieId: string;
  venueId: string;
  screenId: string;
  city: string;
  startsAt: Date;
  endsAt: Date;
  prices: CategoryPrices;
  status: ShowStatus;
  /**
   * Outbox embedded in the document. MongoDB writes to a single document are atomic, so the
   * show and the event announcing it are saved together without needing a multi-document
   * transaction (which would require a replica set). A relay publishes and removes them.
   */
  pendingEvents: EventEnvelope[];
  hasPendingEvents: boolean;
  createdAt: Date;
}

export interface CatalogDb {
  client: MongoClient;
  db: Db;
  movies: Collection<MovieDoc>;
  venues: Collection<VenueDoc>;
  shows: Collection<ShowDoc>;
}

export async function connectMongo(url: string): Promise<CatalogDb> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const db = client.db();
  const catalog: CatalogDb = {
    client,
    db,
    movies: db.collection<MovieDoc>('movies'),
    venues: db.collection<VenueDoc>('venues'),
    shows: db.collection<ShowDoc>('shows'),
  };
  await Promise.all([
    catalog.shows.createIndex({ movieId: 1, city: 1, startsAt: 1 }),
    catalog.shows.createIndex({ venueId: 1, screenId: 1, startsAt: 1 }),
    catalog.shows.createIndex({ hasPendingEvents: 1 }),
    catalog.venues.createIndex({ city: 1 }),
  ]);
  return catalog;
}
