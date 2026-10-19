// k6 run load-tests/k6/browse.js
// Read-heavy traffic (what most users do): list movies → showtimes → seat map.
// Run it twice and compare: catalog responses carry X-Cache: HIT|MISS headers.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const cacheHits = new Rate('catalog_cache_hit_rate');

export const options = {
  stages: [
    { duration: '10s', target: 50 },
    { duration: '30s', target: 50 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:movies}': ['p(95)<150'],
    'http_req_duration{name:showtimes}': ['p(95)<200'],
    'http_req_duration{name:seatmap}': ['p(95)<300'],
  },
};

const CITIES = ['Bengaluru', 'Mumbai', 'Hyderabad'];

export default function () {
  const city = CITIES[Math.floor(Math.random() * CITIES.length)];
  const movies = http.get(`${BASE}/api/catalog/movies?city=${city}`, { tags: { name: 'movies' } });
  check(movies, { 'movies 200': (r) => r.status === 200 });
  cacheHits.add(movies.headers['X-Cache'] === 'HIT');
  const list = movies.json();
  if (!list.length) return;

  const movie = list[Math.floor(Math.random() * list.length)];
  const date = new Date(Date.now() + 5.5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const st = http.get(`${BASE}/api/catalog/movies/${movie.id}/showtimes?city=${city}&date=${date}`, { tags: { name: 'showtimes' } });
  check(st, { 'showtimes 200': (r) => r.status === 200 });
  cacheHits.add(st.headers['X-Cache'] === 'HIT');

  const groups = st.json();
  if (groups.length && groups[0].shows.length) {
    const show = groups[0].shows[0];
    const seats = http.get(`${BASE}/api/bookings/shows/${show.id}/seats`, { tags: { name: 'seatmap' } });
    check(seats, { 'seatmap 200': (r) => r.status === 200 });
  }
  sleep(0.5 + Math.random());
}
