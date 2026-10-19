// k6 run load-tests/k6/double-booking.js
// Optional: -e USERS=300 -e BASE_URL=http://localhost:8080
// The gateway must run with RATE_LIMIT_ENABLED=false (all virtual users share one IP).
//
// N virtual users try to hold the SAME seat at the same moment. Pass criteria:
// exactly one 201, everyone else 409, no 5xx.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const USERS = Number(__ENV.USERS || 200);

const won = new Counter('holds_won');
const conflicted = new Counter('holds_conflicted');
const unexpected = new Counter('holds_unexpected');

export const options = {
  setupTimeout: '180s',
  scenarios: {
    stampede: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: '60s' },
  },
  thresholds: {
    holds_won: ['count==1'],
    holds_unexpected: ['count==0'],
    'http_req_duration{name:hold}': ['p(95)<1500'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };

export function setup() {
  // Find an upcoming show with seats ready.
  const cities = 'Bengaluru';
  const movies = http.get(`${BASE}/api/catalog/movies?city=${cities}`).json();
  let showId;
  for (let d = 1; d < 6 && !showId; d++) {
    const date = new Date(Date.now() + 5.5 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
    for (const m of movies) {
      const groups = http.get(`${BASE}/api/catalog/movies/${m.id}/showtimes?city=${cities}&date=${date}`).json();
      if (groups.length && groups[0].shows.length) {
        showId = groups[0].shows[groups[0].shows.length - 1].id;
        break;
      }
    }
  }
  const seats = http.get(`${BASE}/api/bookings/shows/${showId}/seats`).json().seats;
  const seat = seats.filter((s) => s.status === 'AVAILABLE').pop().seatId;

  const tokens = [];
  for (let i = 0; i < USERS; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(i + 50, USERS); j++) {
      batch.push(['POST', `${BASE}/api/auth/register`, JSON.stringify({ name: `k6 user ${j}`, email: `k6-${Date.now()}-${j}@load.test`, password: 'password123' }), json]);
    }
    for (const r of http.batch(batch)) tokens.push(r.json('accessToken'));
  }
  console.log(`show ${showId}, seat ${seat}, ${tokens.length} users`);
  return { showId, seat, tokens };
}

export default function (data) {
  const token = data.tokens[exec.vu.idInTest - 1];
  const res = http.post(`${BASE}/api/bookings/holds`, JSON.stringify({ showId: data.showId, seatIds: [data.seat] }), {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    tags: { name: 'hold' },
  });
  if (res.status === 201) won.add(1);
  else if (res.status === 409) conflicted.add(1);
  else unexpected.add(1);
  check(res, { 'is 201 or 409': (r) => r.status === 201 || r.status === 409 });
}
