import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { ErrorNote, Loading } from '../components/ui';
import { api } from '../lib/api';
import { rupees, shortDate, showTime } from '../lib/format';
import { useSession } from '../lib/session';

function Stats() {
  const { data } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api('/bookings/admin/stats'), refetchInterval: 10_000 });
  const get = (s) => data?.find((r) => r.status === s);
  return (
    <dl className="stats">
      <div>
        <dt>Confirmed bookings</dt>
        <dd>{get('CONFIRMED')?.count ?? 0}</dd>
      </div>
      <div>
        <dt>Revenue</dt>
        <dd>{rupees(get('CONFIRMED')?.revenue ?? 0, { compact: true })}</dd>
      </div>
      <div>
        <dt>Awaiting payment</dt>
        <dd>{get('PENDING')?.count ?? 0}</dd>
      </div>
      <div>
        <dt>Expired holds</dt>
        <dd>{get('EXPIRED')?.count ?? 0}</dd>
      </div>
      <div>
        <dt>Cancelled</dt>
        <dd>{get('CANCELLED')?.count ?? 0}</dd>
      </div>
    </dl>
  );
}

function NewMovie() {
  const qc = useQueryClient();
  const [f, setF] = useState({
    title: '',
    description: '',
    durationMins: '120',
    languages: 'Hindi',
    genres: 'Drama',
    certificate: 'UA',
    releaseDate: new Date().toISOString().slice(0, 10),
  });
  const m = useMutation({
    mutationFn: () =>
      api('/catalog/movies', {
        method: 'POST',
        body: {
          ...f,
          durationMins: Number(f.durationMins),
          languages: f.languages.split(',').map((s) => s.trim()),
          genres: f.genres.split(',').map((s) => s.trim()),
        },
      }),
    onSuccess: () => {
      setF({ ...f, title: '', description: '' });
      void qc.invalidateQueries({ queryKey: ['movies'] });
    },
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="admin-form" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <h2 className="section-title">Add a film</h2>
      <label className="field">
        <span>Title</span>
        <input value={f.title} onChange={set('title')} required />
      </label>
      <label className="field">
        <span>Synopsis</span>
        <textarea value={f.description} onChange={set('description')} rows={3} />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Minutes</span>
          <input type="number" value={f.durationMins} onChange={set('durationMins')} />
        </label>
        <label className="field">
          <span>Certificate</span>
          <select value={f.certificate} onChange={set('certificate')}>
            <option>U</option>
            <option>UA</option>
            <option>A</option>
          </select>
        </label>
        <label className="field">
          <span>Release date</span>
          <input type="date" value={f.releaseDate} onChange={set('releaseDate')} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span>Languages (comma separated)</span>
          <input value={f.languages} onChange={set('languages')} />
        </label>
        <label className="field">
          <span>Genres (comma separated)</span>
          <input value={f.genres} onChange={set('genres')} />
        </label>
      </div>
      {m.error && <ErrorNote error={m.error} />}
      {m.isSuccess && <p className="field-ok">Added {m.data.title}. Schedule it below.</p>}
      <button className="button button--primary" disabled={m.isPending}>
        Add film
      </button>
    </form>
  );
}

function NewShow() {
  const qc = useQueryClient();
  const movies = useQuery({ queryKey: ['movies', 'all'], queryFn: () => api('/catalog/movies') });
  const venues = useQuery({ queryKey: ['venues'], queryFn: () => api('/catalog/venues') });
  const [f, setF] = useState({ movieId: '', venueId: '', screenId: '', startsAt: '', REGULAR: '180', PREMIUM: '260', RECLINER: '450' });
  const venue = venues.data?.find((v) => v.id === f.venueId);
  const screen = venue?.screens.find((s) => s.id === f.screenId);
  const categories = [...new Set(screen?.layout.sections.map((s) => s.category) ?? [])];
  const m = useMutation({
    mutationFn: () =>
      api('/catalog/shows', {
        method: 'POST',
        body: {
          movieId: f.movieId,
          venueId: f.venueId,
          screenId: f.screenId,
          startsAt: new Date(`${f.startsAt}:00+05:30`).toISOString(),
          prices: Object.fromEntries(categories.map((c) => [c, Math.round(Number(f[c]) * 100)])),
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-shows'] }),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="admin-form" onSubmit={(e) => (e.preventDefault(), m.mutate())}>
      <h2 className="section-title">Schedule a show</h2>
      <label className="field">
        <span>Film</span>
        <select value={f.movieId} onChange={set('movieId')} required>
          <option value="">Choose a film</option>
          {movies.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label className="field">
          <span>Venue</span>
          <select value={f.venueId} onChange={(e) => setF({ ...f, venueId: e.target.value, screenId: '' })} required>
            <option value="">Choose a venue</option>
            {venues.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Screen</span>
          <select value={f.screenId} onChange={set('screenId')} required disabled={!venue}>
            <option value="">Choose a screen</option>
            {venue?.screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Starts at (India time)</span>
        <input type="datetime-local" value={f.startsAt} onChange={set('startsAt')} required />
      </label>
      {categories.length > 0 && (
        <div className="field-row">
          {categories.map((c) => (
            <label key={c} className="field">
              <span>{c[0] + c.slice(1).toLowerCase()} price (₹)</span>
              <input type="number" min={0} value={f[c]} onChange={set(c)} />
            </label>
          ))}
        </div>
      )}
      {m.error && <ErrorNote error={m.error} />}
      {m.isSuccess && <p className="field-ok">Scheduled with {m.data.seats} seats. Booking opens as soon as the seat map syncs.</p>}
      <button className="button button--primary" disabled={m.isPending}>
        Schedule show
      </button>
    </form>
  );
}

function Shows() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-shows'], queryFn: () => api('/catalog/admin/shows') });
  const cancel = useMutation({
    mutationFn: (id) => api(`/catalog/shows/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelled by the venue' } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-shows'] }),
  });
  if (isLoading) return <Loading />;
  return (
    <section>
      <h2 className="section-title">Upcoming shows</h2>
      <p className="muted">Cancelling a show cancels every booking for it and refunds each customer automatically.</p>
      {cancel.error && <ErrorNote error={cancel.error} />}
      <table className="admin-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Film</th>
            <th>Venue</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.slice(0, 40).map((s) => (
            <tr key={s.id} className={s.status === 'CANCELLED' ? 'is-cancelled' : ''}>
              <td>
                {shortDate(s.startsAt)}, {showTime(s.startsAt)}
              </td>
              <td>{s.movieTitle}</td>
              <td>
                {s.venueName}, {s.screenName}
              </td>
              <td>
                {s.status === 'CANCELLED' ? (
                  'Cancelled'
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    disabled={cancel.isPending}
                    onClick={() => confirm(`Cancel ${s.movieTitle} and refund everyone?`) && cancel.mutate(s.id)}
                  >
                    Cancel show
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AdminPage() {
  const { user, ready } = useSession();
  if (!ready)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (user?.role !== 'ADMIN') return <Navigate to="/login?next=/admin" replace />;
  return (
    <main className="page">
      <h1 className="page-title">Admin</h1>
      <Stats />
      <div className="admin-grid">
        <NewMovie />
        <NewShow />
      </div>
      <Shows />
    </main>
  );
}
