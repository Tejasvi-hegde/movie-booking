const TZ = 'Asia/Kolkata';

export const rupees = (paise: number, opts: { compact?: boolean } = {}) => {
  const value = paise / 100;
  const whole = Number.isInteger(value);
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: opts.compact || whole ? 0 : 2,
    maximumFractionDigits: opts.compact ? 0 : 2,
  })}`;
};

export const showTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

export const showDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

export const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

export const duration = (mins: number) => `${Math.floor(mins / 60)}h ${mins % 60}m`;

/** The next `n` days as YYYY-MM-DD in IST, with labels for the date strip. */
export function nextDays(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    const iso = new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    return {
      iso,
      weekday: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short' }),
      day: d.toLocaleDateString('en-IN', { timeZone: TZ, day: 'numeric' }),
      month: d.toLocaleDateString('en-IN', { timeZone: TZ, month: 'short' }),
    };
  });
}

export const bookingRef = (id: string) => id.slice(0, 8).toUpperCase();
