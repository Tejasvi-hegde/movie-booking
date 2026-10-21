import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Poster } from '../components/Poster';
import { Empty, ErrorNote, Loading } from '../components/ui';
import { api } from '../lib/api';
import { duration, nextDays, rupees, showTime } from '../lib/format';
import { useSession } from '../lib/session';

export function MoviePage() {
  const { id = '' } = useParams();
  const { city } = useSession();
  const days = nextDays(5);
  const [date, setDate] = useState(days[0].iso);

  const movie = useQuery({ queryKey: ['movie', id], queryFn: () => api(`/catalog/movies/${id}`) });
  const showtimes = useQuery({
    queryKey: ['showtimes', id, city, date],
    queryFn: () => api(`/catalog/movies/${id}/showtimes?city=${encodeURIComponent(city)}&date=${date}`),
  });

  if (movie.isLoading)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (movie.error || !movie.data)
    return (
      <main className="page">
        <ErrorNote error={movie.error} />
      </main>
    );
  const m = movie.data;

  return (
    <main className="page">
      <div className="film-head">
        <Poster movie={m} size="lg" />
        <div className="film-head__text">
          <h1 className="page-title page-title--film">{m.title}</h1>
          <p className="film-head__facts">
            <span>{m.certificate}</span>
            <span>{duration(m.durationMins)}</span>
            <span>{m.genres.join(', ')}</span>
            <span>{m.languages.join(', ')}</span>
          </p>
          <p className="film-head__synopsis">{m.description}</p>
        </div>
      </div>

      <h2 className="section-title">Showtimes in {city}</h2>
      <div className="date-strip" role="tablist" aria-label="Choose a date">
        {days.map((d) => (
          <button key={d.iso} type="button" role="tab" aria-selected={d.iso === date} className="date-chip" onClick={() => setDate(d.iso)}>
            <span className="date-chip__wd">{d.weekday}</span>
            <span className="date-chip__day">{d.day}</span>
            <span className="date-chip__mo">{d.month}</span>
          </button>
        ))}
      </div>

      {showtimes.isLoading && <Loading />}
      {showtimes.error && <ErrorNote error={showtimes.error} />}
      {showtimes.data?.length === 0 && (
        <Empty title="No shows left on this day">
          <p>Try another date, or another city from the menu at the top.</p>
        </Empty>
      )}
      <ul className="venues">
        {showtimes.data?.map((g) => (
          <li key={g.venue.id} className="venue">
            <div className="venue__name">
              <h3>{g.venue.name}</h3>
              <p>{g.venue.address}</p>
            </div>
            <ul className="times">
              {g.shows.map((s) => (
                <li key={s.id}>
                  <Link to={`/shows/${s.id}`} className="time-chip">
                    <span className="time-chip__time">{showTime(s.startsAt)}</span>
                    <span className="time-chip__meta">
                      {s.screenName}, from {rupees(s.minPrice, { compact: true })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
