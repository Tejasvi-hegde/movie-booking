import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Poster } from '../components/Poster';
import { Empty, ErrorNote, Loading } from '../components/ui';
import { api } from '../lib/api';
import { duration } from '../lib/format';
import { useSession } from '../lib/session';
import type { Movie } from '../lib/types';

export function Home() {
  const { city } = useSession();
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, isLoading, error } = useQuery({
    queryKey: ['movies', city, q],
    queryFn: () => api<Movie[]>(`/catalog/movies?city=${encodeURIComponent(city)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });

  return (
    <main className="page">
      <h1 className="page-title">{q ? `Films matching “${q}”` : `Now showing in ${city}`}</h1>
      {isLoading && <Loading />}
      {error && <ErrorNote error={error} />}
      {data && data.length === 0 && (
        <Empty title={q ? 'No films match that search' : `Nothing is scheduled in ${city} yet`}>
          <p>{q ? 'Try a shorter title, or clear the search to see everything showing.' : 'Pick another city from the menu at the top.'}</p>
          {q && (
            <Link className="button button--quiet" to="/">
              Clear search
            </Link>
          )}
        </Empty>
      )}
      {data && data.length > 0 && (
        <ul className="film-grid">
          {data.map((m) => (
            <li key={m.id}>
              <Link to={`/movies/${m.id}`} className="film-card">
                <Poster movie={m} />
                <span className="film-card__title">{m.title}</span>
                <span className="film-card__meta">
                  {m.languages.join(', ')}, {duration(m.durationMins)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
