import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Empty, ErrorNote, Loading, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { rupees, shortDate, showTime } from '../lib/format';

export function MyBookings() {
  const { data, isLoading, error } = useQuery({ queryKey: ['my-bookings'], queryFn: () => api('/bookings/me') });
  const now = Date.now();
  const upcoming = data?.filter((b) => b.status === 'CONFIRMED' && new Date(b.show.startsAt).getTime() > now) ?? [];
  const rest = data?.filter((b) => !upcoming.includes(b)) ?? [];

  const row = (b) => (
    <li key={b.id}>
      <Link to={b.status === 'PENDING' ? `/checkout/${b.id}` : `/bookings/${b.id}`} className="booking-row">
        <span className="booking-row__when">
          <b>{shortDate(b.show.startsAt)}</b>
          {showTime(b.show.startsAt)}
        </span>
        <span className="booking-row__what">
          <b>{b.show.movieTitle}</b>
          {b.show.venueName}, seats {b.seats.join(', ')}
        </span>
        <span className="booking-row__status">
          <StatusPill status={b.status} />
          {rupees(b.amount)}
        </span>
      </Link>
    </li>
  );

  return (
    <main className="page page--narrow">
      <h1 className="page-title">My bookings</h1>
      {isLoading && <Loading />}
      {error && <ErrorNote error={error} />}
      {data?.length === 0 && (
        <Empty title="No bookings yet">
          <Link className="button button--primary" to="/">
            Find a film
          </Link>
        </Empty>
      )}
      {upcoming.length > 0 && (
        <>
          <h2 className="section-title">Coming up</h2>
          <ul className="booking-list">{upcoming.map(row)}</ul>
        </>
      )}
      {rest.length > 0 && (
        <>
          <h2 className="section-title">History</h2>
          <ul className="booking-list booking-list--past">{rest.map(row)}</ul>
        </>
      )}
    </main>
  );
}
