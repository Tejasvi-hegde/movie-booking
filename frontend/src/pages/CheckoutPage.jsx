import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Countdown } from '../components/Countdown';
import { PriceBreakdown } from '../components/PriceBreakdown';
import { ErrorNote, Loading } from '../components/ui';
import { api, ApiError, newIdempotencyKey } from '../lib/api';
import { rupees, showDate, showTime } from '../lib/format';

/** One idempotency key per booking, kept across reloads, so "Pay" can never create two charges. */
function paymentKey(bookingId) {
  const k = `showtime.pay.${bookingId}`;
  try {
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const fresh = newIdempotencyKey();
    sessionStorage.setItem(k, fresh);
    return fresh;
  } catch {
    return newIdempotencyKey();
  }
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the Razorpay checkout'));
    document.body.appendChild(s);
  });
}

export function CheckoutPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [payment, setPayment] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const [expired, setExpired] = useState(false);

  const booking = useQuery({
    queryKey: ['booking', id],
    queryFn: () => api(`/bookings/${id}`),
    refetchInterval: waiting ? 700 : false,
  });

  // The saga finishes asynchronously: payment → event → booking confirmed. Wait for the outcome.
  useEffect(() => {
    const status = booking.data?.status;
    if (!status || status === 'PENDING') return;
    setWaiting(false);
    if (status === 'CONFIRMED') navigate(`/bookings/${id}`, { replace: true });
  }, [booking.data?.status, id, navigate]);

  const start = useMutation({
    mutationFn: () => api('/payments/intents', { method: 'POST', idempotencyKey: paymentKey(id), body: { bookingId: id } }),
    onSuccess: async (p) => {
      setPayment(p);
      if (p.checkout?.mode === 'razorpay') {
        await loadRazorpay();
        new window.Razorpay({
          key: p.checkout.keyId,
          order_id: p.checkout.orderId,
          amount: p.amount,
          currency: 'INR',
          name: 'Showtime',
          handler: async (r) => {
            setWaiting(true);
            await api(`/payments/${p.id}/razorpay/verify`, { method: 'POST', body: r }).catch(() => undefined);
          },
        }).open();
      }
    },
  });

  const complete = useMutation({
    mutationFn: (outcome) => api(`/payments/${payment.id}/mock/complete`, { method: 'POST', body: { outcome } }),
    onSuccess: () => setWaiting(true),
  });

  const release = useMutation({
    mutationFn: () => api(`/bookings/${id}/cancel`, { method: 'POST' }),
    onSuccess: (b) => navigate(`/shows/${b.showId}`),
  });

  if (booking.isLoading)
    return (
      <main className="page">
        <Loading />
      </main>
    );
  if (booking.error || !booking.data)
    return (
      <main className="page">
        <ErrorNote error={booking.error} />
      </main>
    );
  const b = booking.data;
  const pending = b.status === 'PENDING' && !expired;

  return (
    <main className="page page--narrow">
      <h1 className="page-title">
        {pending ? 'Pay for your seats' : b.status === 'CONFIRMED' ? 'Payment received' : 'This booking was not completed'}
      </h1>

      <section className="checkout">
        <div className="checkout__film">
          <h2>{b.show?.movieTitle}</h2>
          <p>
            {b.show && `${showTime(b.show.startsAt)}, ${showDate(b.show.startsAt)}`}
            <br />
            {b.show?.venueName}, {b.show?.screenName}
          </p>
          <p className="checkout__seats">Seats {b.seats.join(', ')}</p>
        </div>
        {pending && (
          <div className="checkout__timer">
            <span>Seats held for</span>
            <Countdown until={b.expiresAt} onExpire={() => setExpired(true)} />
          </div>
        )}
      </section>

      <PriceBreakdown breakdown={b.priceBreakdown} />

      {pending && !waiting && (
        <>
          {!payment && (
            <div className="checkout__actions">
              <button
                type="button"
                className="button button--primary button--block"
                disabled={start.isPending}
                onClick={() => start.mutate()}
              >
                {start.isPending ? 'Starting payment…' : `Pay ${rupees(b.amount)}`}
              </button>
              <button type="button" className="link-button" disabled={release.isPending} onClick={() => release.mutate()}>
                Release these seats
              </button>
            </div>
          )}

          {payment?.checkout?.mode === 'mock' && (
            <div className="gateway" role="dialog" aria-label="Test payment gateway">
              <p className="gateway__title">Test payment gateway</p>
              <p className="gateway__body">
                No real money moves. Choose how this payment should end; the gateway then sends a signed webhook to the payment service,
                exactly like a real provider.
              </p>
              <div className="gateway__card" aria-hidden="true">
                <span>4111 1111 1111 1111</span>
                <span>Demo card, 12/30</span>
              </div>
              <div className="gateway__actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('success')}
                >
                  Pay {rupees(payment.amount)}
                </button>
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={complete.isPending}
                  onClick={() => complete.mutate('failure')}
                >
                  Decline the card
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {waiting && b.status === 'PENDING' && (
        <div className="note" role="status">
          <Loading label="Confirming" />
          <p>Payment received. Confirming your seats…</p>
        </div>
      )}

      {(start.error || complete.error) && (
        <ErrorNote
          error={start.error ?? complete.error}
          action={
            start.error instanceof ApiError && start.error.code === 'HOLD_EXPIRED' ? (
              <Link to={`/shows/${b.showId}`}>Choose seats again</Link>
            ) : undefined
          }
        />
      )}

      {(!pending || b.status !== 'PENDING') && b.status !== 'CONFIRMED' && (
        <div className="note note--error">
          <p>
            {expired && b.status === 'PENDING'
              ? 'Your 5-minute hold ran out, so the seats were released.'
              : (b.statusReason ?? 'This booking is no longer active.')}
          </p>
          <Link className="button button--small" to={`/shows/${b.showId}`}>
            Choose seats again
          </Link>
        </div>
      )}
    </main>
  );
}
