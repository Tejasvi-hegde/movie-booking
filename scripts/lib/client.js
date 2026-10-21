import { randomUUID } from 'node:crypto';

export const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';

/** Tiny API client for the scripts: JSON in/out, bearer token, optional idempotency key. */
export async function api(method, path, opts = {}) {
  const res = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers };
}

export async function register(prefix = 'user') {
  const email = `${prefix}-${randomUUID().slice(0, 8)}@test.showtime.dev`;
  const r = await api('POST', '/api/auth/register', { body: { name: `${prefix} tester`, email, password: 'password123' } });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.accessToken, userId: r.body.user.id, email };
}

export async function waitFor(what, fn, timeoutMs = 15_000, everyMs = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Finds an upcoming show (in the given city) whose seat inventory is ready in the booking service. */
export async function findBookableShow(city = 'Bengaluru', skip = 0) {
  const movies = await api('GET', `/api/catalog/movies?city=${encodeURIComponent(city)}`);
  let seen = 0;
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.now() + 5.5 * 3_600_000 + d * 86_400_000).toISOString().slice(0, 10);
    for (const movie of movies.body) {
      const st = await api('GET', `/api/catalog/movies/${movie.id}/showtimes?city=${encodeURIComponent(city)}&date=${date}`);
      for (const group of st.body) {
        for (const show of group.shows) {
          // At least 3h away, so cancellation (2h cut-off) can be exercised.
          if (new Date(show.startsAt).getTime() - Date.now() < 3 * 3_600_000) continue;
          if (seen++ < skip) continue;
          const seats = await api('GET', `/api/bookings/shows/${show.id}/seats`);
          if (seats.status === 200) return { showId: show.id, movieTitle: movie.title };
        }
      }
    }
  }
  throw new Error('No bookable show found — is the catalog seeded and the booking service running?');
}

export const newKey = () => randomUUID();
