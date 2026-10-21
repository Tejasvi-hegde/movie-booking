import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import { api, auth } from '../lib/api';
import { useSession } from '../lib/session';

function Notifications() {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(null);
  const ref = useRef(null);
  const { data = [] } = useQuery({ queryKey: ['notifications'], queryFn: () => api('/notifications/me'), refetchInterval: 15_000 });
  const unread = data.length > 0 && data[0].id !== seen;

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <div className="notices" ref={ref}>
      <button
        type="button"
        className={`icon-button ${unread ? 'icon-button--dot' : ''}`}
        aria-expanded={open}
        aria-label={unread ? 'Updates (new)' : 'Updates'}
        onClick={() => {
          setOpen(!open);
          if (data[0]) setSeen(data[0].id);
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z" />
          <path d="M10 20a2 2 0 0 0 4 0" />
        </svg>
      </button>
      {open && (
        <div className="notices__panel" role="dialog" aria-label="Updates">
          {data.length === 0 ? (
            <p className="notices__empty">Booking confirmations and refunds will show up here.</p>
          ) : (
            <ul>
              {data.slice(0, 8).map((n) => (
                <li key={n.id} className={`notice notice--${n.kind}`}>
                  <strong>{n.title}</strong>
                  <p>{n.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { user, city, setCity } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data: cities = [] } = useQuery({ queryKey: ['cities'], queryFn: () => api('/catalog/cities'), staleTime: 300_000 });

  const search = (e) => {
    e.preventDefault();
    navigate(q.trim() ? `/?q=${encodeURIComponent(q.trim())}` : '/');
  };

  return (
    <header className="masthead">
      <div className="masthead__inner">
        <Link to="/" className="wordmark" aria-label="Showtime home">
          Showtime
        </Link>
        <label className="city">
          <span className="sr-only">City</span>
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            {(cities.length ? cities : [city]).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <form className="search" role="search" onSubmit={search}>
          <label className="sr-only" htmlFor="search">
            Search films
          </label>
          <input id="search" type="search" placeholder="Search films" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <nav className="masthead__nav" aria-label="Account">
          {user ? (
            <>
              <NavLink to="/bookings">My bookings</NavLink>
              {user.role === 'ADMIN' && <NavLink to="/admin">Admin</NavLink>}
              <Notifications />
              <button
                type="button"
                className="link-button"
                onClick={async () => {
                  await auth.logout();
                  navigate('/');
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <NavLink to="/login" className="button button--small">
              Sign in
            </NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}
