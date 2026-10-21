const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function wrap(title, body) {
  return `<!doctype html><html><body style="margin:0;background:#f6f5fa;color:#1e1b2e">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e1deec">
    <tr><td style="padding:20px 28px;background:#1e1b2e;color:#f2b33d;font-family:Arial,sans-serif;font-size:18px;font-weight:bold">Showtime</td></tr>
    <tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-family:Arial,sans-serif;font-size:22px">${esc(title)}</h1>${body}</td></tr>
    <tr><td style="padding:16px 28px;border-top:1px dashed #e1deec;font-size:12px;color:#6b6780;font-family:Arial,sans-serif">
      This is a demo project. No real tickets or money were involved.</td></tr>
  </table></td></tr></table></body></html>`;
}

const row = (k, v) =>
  `<tr><td style="padding:6px 0;color:#6b6780;font-family:Arial,sans-serif;font-size:13px">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-family:Arial,sans-serif;font-size:14px">${esc(v)}</td></tr>`;

/** Turns a domain event into a user-facing message, or null if users don't need to hear about it. */
export function render(event) {
  switch (event.type) {
    case 'booking.confirmed': {
      const d = event.data;
      const title = `You're going to ${d.movieTitle}!`;
      return {
        userId: d.userId,
        email: d.userEmail,
        kind: 'success',
        title,
        text: `${d.movieTitle} · ${when(d.startsAt)} · ${d.venueName}, ${d.screenName} · Seats ${d.seats.join(', ')} · Paid ${rupees(d.amount)} · Booking ${d.bookingId.slice(0, 8).toUpperCase()}`,
        html: wrap(
          title,
          `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">Hi ${esc(d.userName)}, your booking is confirmed. Show this email at the entrance.</p>
           <table width="100%" style="margin-top:12px">${row('Show', when(d.startsAt))}${row('Venue', `${d.venueName} · ${d.screenName}`)}${row('Seats', d.seats.join(', '))}${row('Amount paid', rupees(d.amount))}${row('Booking ID', d.bookingId.slice(0, 8).toUpperCase())}</table>`,
        ),
        emailWorthy: true,
      };
    }
    case 'booking.failed': {
      const d = event.data;
      const title = d.refundRequired ? 'We could not confirm your seats' : 'Payment did not go through';
      const text = d.refundRequired
        ? `${d.reason}. Your payment has been refunded in full, it usually reaches your account in 5–7 working days.`
        : `${d.reason}. Your seats have been released; you can pick them again if they are still free.`;
      return {
        userId: d.userId,
        email: d.userEmail,
        kind: 'warning',
        title,
        text,
        html: wrap(title, `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${esc(text)}</p>`),
        emailWorthy: d.refundRequired,
      };
    }
    case 'booking.expired': {
      const d = event.data;
      return {
        userId: d.userId,
        email: d.userEmail,
        kind: 'info',
        title: 'Your seat hold expired',
        text: `Seats ${d.seats.join(', ')} were released because payment was not completed in time.`,
        html: '',
        emailWorthy: false,
      };
    }
    case 'booking.cancelled': {
      const d = event.data;
      if (!d.refundRequired) return null; // user replaced/abandoned an unpaid hold — not worth a message
      const title = `Booking cancelled: ${d.movieTitle}`;
      const text = `${d.reason}. Seats ${d.seats.join(', ')} are cancelled and ${rupees(d.amount)} will be refunded.`;
      return {
        userId: d.userId,
        email: d.userEmail,
        kind: 'info',
        title,
        text,
        html: wrap(title, `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${esc(text)}</p>`),
        emailWorthy: true,
      };
    }
    case 'payment.refunded': {
      const d = event.data;
      const title = `Refund of ${rupees(d.amount)} processed`;
      const text = `Reason: ${d.reason}. Refunds usually reach your account in 5–7 working days.`;
      return {
        userId: d.userId,
        email: d.userEmail,
        kind: 'info',
        title,
        text,
        html: wrap(title, `<p style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">${esc(text)}</p>`),
        emailWorthy: Boolean(d.userEmail),
      };
    }
    default:
      return null;
  }
}
