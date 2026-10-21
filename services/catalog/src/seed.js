// All titles are fictional.
const MOVIES = [
  {
    title: 'The Last Monsoon',
    description: 'A retired boatman takes one final journey down a flooding river to reunite a scattered family.',
    durationMins: 142,
    languages: ['Kannada', 'Hindi'],
    genres: ['Drama'],
    certificate: 'U',
    releaseDate: '2026-09-26',
  },
  {
    title: 'Neon Circuit',
    description: 'A street racer and a hacker uncover a city-wide traffic AI that is rigging more than races.',
    durationMins: 128,
    languages: ['English', 'Hindi'],
    genres: ['Action', 'Sci-Fi'],
    certificate: 'UA',
    releaseDate: '2026-10-09',
  },
  {
    title: 'Kaveri Nights',
    description: 'Two strangers keep missing each other across one long, chaotic night in Bengaluru.',
    durationMins: 118,
    languages: ['Kannada'],
    genres: ['Romance', 'Comedy'],
    certificate: 'U',
    releaseDate: '2026-10-02',
  },
  {
    title: 'Orbit of Ashes',
    description: 'The crew of a failing space station must choose who gets the last seat home.',
    durationMins: 155,
    languages: ['English'],
    genres: ['Sci-Fi', 'Thriller'],
    certificate: 'UA',
    releaseDate: '2026-10-16',
  },
  {
    title: 'Paper Tigers',
    description: 'A small-town cricket team of misfits enters a tournament they have no business winning.',
    durationMins: 134,
    languages: ['Hindi', 'Telugu'],
    genres: ['Sports', 'Comedy'],
    certificate: 'U',
    releaseDate: '2026-09-19',
  },
  {
    title: 'Silent Frequency',
    description: 'A radio host starts receiving calls from listeners who describe crimes that have not happened yet.',
    durationMins: 121,
    languages: ['Tamil', 'English'],
    genres: ['Mystery', 'Thriller'],
    certificate: 'A',
    releaseDate: '2026-10-12',
  },
];

const compact = {
  sections: [
    { category: 'REGULAR', rows: ['A', 'B', 'C', 'D', 'E'], seatsPerRow: 12, aisleAfter: [3, 9] },
    { category: 'PREMIUM', rows: ['F', 'G', 'H'], seatsPerRow: 12, aisleAfter: [3, 9] },
  ],
};
const large = {
  sections: [
    { category: 'REGULAR', rows: ['A', 'B', 'C', 'D'], seatsPerRow: 16, aisleAfter: [4, 12] },
    { category: 'PREMIUM', rows: ['E', 'F', 'G', 'H', 'J'], seatsPerRow: 16, aisleAfter: [4, 12] },
    { category: 'RECLINER', rows: ['K', 'L'], seatsPerRow: 8, aisleAfter: [4] },
  ],
};

const VENUES = [
  {
    name: 'Lakeside Cinemas: Indiranagar',
    city: 'Bengaluru',
    address: '100 Feet Road, Indiranagar',
    screens: [
      { name: 'Audi 1', layout: large },
      { name: 'Audi 2', layout: compact },
    ],
  },
  {
    name: 'Orion Screens: Rajajinagar',
    city: 'Bengaluru',
    address: 'Dr Rajkumar Road, Rajajinagar',
    screens: [
      { name: 'Screen 1', layout: large },
      { name: 'Screen 2', layout: compact },
    ],
  },
  {
    name: 'Silverline Multiplex: Whitefield',
    city: 'Bengaluru',
    address: 'ITPL Main Road, Whitefield',
    screens: [{ name: 'Gold', layout: large }],
  },
  {
    name: 'Harbour Talkies: Bandra',
    city: 'Mumbai',
    address: 'Linking Road, Bandra West',
    screens: [
      { name: 'Screen A', layout: large },
      { name: 'Screen B', layout: compact },
    ],
  },
  { name: 'Marine Picture House', city: 'Mumbai', address: 'Marine Drive, Churchgate', screens: [{ name: 'Main Hall', layout: compact }] },
  { name: 'Charminar Cineplex', city: 'Hyderabad', address: 'Banjara Hills Road No. 1', screens: [{ name: 'Audi 1', layout: large }] },
];

// Show start times in IST. Each slot leaves room for the longest film + cleaning buffer.
const SLOTS = ['10:00', '13:30', '17:15', '21:00'];
const PRICES = { REGULAR: 180_00, PREMIUM: 260_00, RECLINER: 450_00 };

const istDate = (offsetDays) => new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Idempotent demo seed: creates movies + venues once, then makes sure each of the next
 * `daysAhead` days has a schedule. Runs on every startup so a long-running demo never runs
 * out of upcoming shows.
 */
export async function seedCatalog(db, catalog, logger, daysAhead) {
  if ((await db.movies.countDocuments()) === 0) {
    for (const m of MOVIES) await catalog.createMovie(m);
    for (const v of VENUES) await catalog.createVenue(v);
    logger.info({ movies: MOVIES.length, venues: VENUES.length }, 'Seeded movies and venues');
  }
  const movies = await db.movies.find().sort({ title: 1 }).toArray();
  const venues = await db.venues.find().sort({ name: 1 }).toArray();
  if (!movies.length || !venues.length) return;

  let created = 0;
  for (let d = 0; d < daysAhead; d++) {
    const date = istDate(d);
    const from = new Date(`${date}T00:00:00+05:30`);
    const exists = await db.shows.countDocuments({ startsAt: { $gte: from, $lt: new Date(from.getTime() + 86_400_000) } });
    if (exists) continue;
    let i = d;
    for (const venue of venues) {
      for (const screen of venue.screens) {
        for (const slot of SLOTS) {
          const startsAt = new Date(`${date}T${slot}:00+05:30`);
          if (startsAt.getTime() < Date.now() + 30 * 60_000) continue;
          const movie = movies[i++ % movies.length];
          await catalog
            .createShow({ movieId: movie._id, venueId: venue._id, screenId: screen.screenId, startsAt, prices: PRICES })
            .then(() => created++)
            .catch((err) => logger.warn({ err: err.message, date, slot }, 'Skipped seeding show'));
        }
      }
    }
  }
  if (created) logger.info({ created }, 'Seeded upcoming shows');
}
