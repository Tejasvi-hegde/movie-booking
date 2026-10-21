import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PriceBreakdown } from '../components/PriceBreakdown';
import { SeatMap } from '../components/SeatMap';
import { ErrorNote, Loading } from '../components/ui';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import { rupees, showDate, showTime } from '../lib/format';
import { useSession } from '../lib/session';

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ShowPage() {
  const { id = '' } = useParams();
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  const [selected, setSelected] = useState(new Set());
  const [coupon, setCoupon] = useState('');
  const [notice, setNotice] = useState(null);
  const [flash, setFlash] = useState(new Set());
  const holdKey = useRef(newIdempotencyKey());

  const show = useQuery({ queryKey: ['show', id], queryFn: () => api(`/catalog/shows/${id}`) });
  const seatMap = useQuery({
    queryKey: ['seats', id, user?.id],
    queryFn: () => api(`/bookings/shows/${id}/seats`),
    refetchInterval: (q) => (q.state.error instanceof ApiError && q.state.error.status === 404 ? 2_000 : 15_000),
    retry: false,
  });
  const coupons = useQuery({ queryKey: ['coupons'], queryFn: () => api('/bookings/coupons'), staleTime: Infinity });

  // Live updates: another customer's hold or purchase shows up within a moment.
  useEffect(() => {
    const es = new EventSource(`/api/bookings/shows/${id}/stream`);
    es.addEventListener('seats', (e) => {
      const change = JSON.parse(e.data);
      setFlash(new Set(change.seatIds));
      void qc.invalidateQueries({ queryKey: ['seats', id] });
    });
    return () => es.close();
  }, [id, qc]);

  // If a seat in my selection was just taken by someone else, drop it and say so.
  useEffect(() => {
    if (!seatMap.data) return;
    const taken = [...selected].filter((sid) => {
      const s = seatMap.data.seats.find((x) => x.seatId === sid);
      return !s || s.status === 'BOOKED' || s.status === 'HELD';
    });
    if (taken.length) {
      setSelected((prev) => new Set([...prev].filter((s) => !taken.includes(s))));
      setNotice(`${taken.join(', ')} ${taken.length > 1 ? 'were' : 'was'} just taken by someone else.`);
    }
  }, [seatMap.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const seatList = useMemo(() => [...selected].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), [selected]);
  const debouncedSeats = useDebounced(seatList, 250);
  const debouncedCoupon = useDebounced(coupon.trim(), 400);
  const quote = useQuery({
    queryKey: ['quote', id, debouncedSeats, debouncedCoupon],
    queryFn: () =>
      api('/bookings/quote', { method: 'POST', body: { showId: id, seatIds: debouncedSeats, couponCode: debouncedCoupon || undefined } }),
    enabled: debouncedSeats.length > 0,
    retry: false,
  });

  const hold = useMutation({
    mutationFn: () =>
      api('/bookings/holds', {
        method: 'POST',
        idempotencyKey: holdKey.current,
        body: { showId: id, seatIds: seatList, couponCode: coupon.trim() || undefined },
      }),
    onSuccess: (b) => navigate(`/checkout/${b.id}`),
    onError: (err) => {
      holdKey.current = newIdempotencyKey(); // a new attempt gets a new key
      if (err instanceof ApiError && err.code === 'SEATS_UNAVAILABLE') {
        const lost = (err.details?.seatIds ?? []).join(', ');
        setNotice(`${lost || 'Some seats'} ${lost.includes(',') ? 'were' : 'was'} taken a moment ago. Pick again.`);
        setSelected((prev) => new Set([...prev].filter((s) => !lost.split(', ').includes(s))));
        void seatMap.refetch();
      }
    },
  });

  const max = seatMap.data?.maxSeatsPerBooking ?? 10;
  const toggle = (seat) => {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seat.seatId)) next.delete(seat.seatId);
      else if (next.size >= max) setNotice(`You can book up to ${max} seats at a time.`);
      else next.add(seat.seatId);
      return next;
    });
  };

  const proceed = () => {
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    hold.mutate();
  };

  if (show.isLoading)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (show.error || !show.data)
    return (
      <main className="page">
        <ErrorNote error={show.error} />
      </main>
    );
  const s = show.data;
  const notReady = seatMap.error instanceof ApiError && seatMap.error.status === 404;
  const myHold = seatMap.data?.myHold;
  const quoteError = quote.error instanceof ApiError && quote.error.code !== 'VALIDATION_FAILED' ? quote.error : null;

  return (
    <main className="page">
      <div className="show-head">
        <Link to={`/movies/${s.movie.id}`} className="back-link">
          {s.movie.title}
        </Link>
        <h1 className="page-title">
          {showTime(s.startsAt)}, {showDate(s.startsAt)}
        </h1>
        <p className="show-head__venue">
          {s.venue.name}, {s.screen.name}
        </p>
      </div>

      {s.status === 'CANCELLED' && <div className="note note--error">This show has been cancelled by the venue.</div>}

      {myHold && (
        <div className="note note--hold">
          <p>You are holding {myHold.seats.join(', ')} for this show.</p>
          <Link className="button button--small" to={`/checkout/${myHold.id}`}>
            Continue to payment
          </Link>
        </div>
      )}

      <div className="booking-layout">
        <div>
          {notReady && (
            <div className="note">
              <p>Seats for this show are still being set up. This page will update by itself.</p>
            </div>
          )}
          {seatMap.isLoading && <Loading label="Loading seats" />}
          {seatMap.data && (
            <SeatMap sections={s.screen.layout.sections} seats={seatMap.data.seats} selected={selected} onToggle={toggle} flash={flash} />
          )}
        </div>

        <aside className="summary" aria-label="Your selection">
          <h2 className="summary__title">Your seats</h2>
          {seatList.length === 0 ? (
            <p className="summary__hint">Tap seats in the hall to choose them. You can pick up to {max}.</p>
          ) : (
            <p className="summary__seats">{seatList.join(', ')}</p>
          )}

          {notice && (
            <p className="summary__notice" role="status">
              {notice}
            </p>
          )}

          {seatList.length > 0 && (
            <>
              <label className="field">
                <span>Coupon code</span>
                <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} placeholder="Optional" autoComplete="off" />
              </label>
              {coupons.data && (
                <ul className="coupons">
                  {coupons.data.map((c) => (
                    <li key={c.code}>
                      <button type="button" className="coupon" onClick={() => setCoupon(c.code)} aria-pressed={coupon === c.code}>
                        <b>{c.code}</b> {c.description}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {quoteError && <p className="field-error">{quoteError.message}</p>}
              {quote.data && <PriceBreakdown breakdown={quote.data} />}
            </>
          )}

          {hold.error && !(hold.error instanceof ApiError && hold.error.code === 'SEATS_UNAVAILABLE') && <ErrorNote error={hold.error} />}

          <button
            type="button"
            className="button button--primary button--block"
            disabled={seatList.length === 0 || hold.isPending || Boolean(quoteError) || s.status === 'CANCELLED'}
            onClick={proceed}
          >
            {hold.isPending
              ? 'Holding your seats…'
              : seatList.length === 0
                ? 'Choose seats'
                : `Hold ${seatList.length} ${seatList.length === 1 ? 'seat' : 'seats'}${quote.data ? ` for ${rupees(quote.data.total)}` : ''}`}
          </button>
          <p className="summary__fineprint">Seats are held for 5 minutes while you pay. Nobody else can take them in that time.</p>
        </aside>
      </div>
    </main>
  );
}
