import { useEffect, useState } from 'react';

/** Remaining time on the seat hold. Turns urgent in the last minute. */
export function Countdown({ until, onExpire }: { until: string; onExpire?: () => void }) {
  const end = new Date(until).getTime();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = Math.max(0, end - now);
  useEffect(() => {
    if (left === 0) onExpire?.();
  }, [left === 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className={`countdown ${left < 60_000 ? 'countdown--urgent' : ''}`} aria-live={left < 60_000 ? 'polite' : 'off'}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}
