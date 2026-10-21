import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ErrorNote, Loading, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { bookingRef, rupees, showDate, showTime } from '../lib/format';

export function TicketPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const booking = useQuery({ queryKey: ['booking', id], queryFn: () => api(`/bookings/${id}`) });
  const paymentId = booking.data?.paymentId;
  const payment = useQuery({
    queryKey: ['payment', paymentId],
    queryFn: () => api(`/payments/${paymentId}`),
    enabled: Boolean(paymentId),
    // After a cancellation the refund lands a moment later via events.
    refetchInterval: (q) => (booking.data?.status === 'CANCELLED' && q.state.data?.status === 'SUCCEEDED' ? 1000 : false),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/bookings/${id}/cancel`, { method: 'POST' }),
    onSuccess: (b) => {
      qc.setQueryData(['booking', id], b);
      void qc.invalidateQueries({ queryKey: ['payment'] });
    },
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
  const startsAt = b.show?.startsAt ?? b.createdAt;
  const canCancel = b.status === 'CONFIRMED' && new Date(startsAt).getTime() - Date.now() > 2 * 3_600_000;

  return (
    <main className="page page--narrow">
      <article className={`ticket ticket--${b.status.toLowerCase()}`}>
        <div className="ticket__main">
          <StatusPill status={b.status} />
          <h1 className="ticket__film">{b.show?.movieTitle}</h1>
          <dl className="ticket__facts">
            <div>
              <dt>When</dt>
              <dd>
                {showTime(startsAt)}
                <br />
                {showDate(startsAt)}
              </dd>
            </div>
            <div>
              <dt>Where</dt>
              <dd>
                {b.show?.venueName}
                <br />
                {b.show?.screenName}
              </dd>
            </div>
          </dl>
        </div>
        <div className="ticket__stub">
          <span className="ticket__seats-label">Seats</span>
          <span className="ticket__seats">{b.seats.join(' ')}</span>
          <span className="ticket__ref">Booking {bookingRef(b.id)}</span>
        </div>
      </article>

      <div className="ticket-after">
        <p>
          {b.status === 'CONFIRMED' && <>Paid {rupees(b.amount)}. A confirmation is in your updates and inbox.</>}
          {b.status === 'CANCELLED' &&
            (payment.data?.status === 'REFUNDED'
              ? `Cancelled. ${rupees(payment.data.amount)} has been refunded.`
              : payment.data
                ? 'Cancelled. Your refund is being processed.'
                : 'Cancelled.')}
          {(b.status === 'FAILED' || b.status === 'EXPIRED') && (b.statusReason ?? 'This booking was not completed.')}
        </p>
        {canCancel && (
          <button
            type="button"
            className="button button--quiet"
            disabled={cancel.isPending}
            onClick={() => {
              if (confirm('Cancel this booking? The full amount will be refunded.')) cancel.mutate();
            }}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel booking and refund'}
          </button>
        )}
        {b.status === 'CONFIRMED' && !canCancel && <p className="muted">Cancellation closes 2 hours before the show.</p>}
        {cancel.error && <ErrorNote error={cancel.error} />}
        <Link to="/bookings">All my bookings</Link>
      </div>
    </main>
  );
}
