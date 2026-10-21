// Typographic posters: every film gets a two-tone field picked from its title, so the grid
// has rhythm without needing (copyrighted) artwork.
const PALETTES = [
  { field: '#8C2346', band: '#5E1530', ink: '#FCE9EF' },
  { field: '#24506B', band: '#16364A', ink: '#E4F2FA' },
  { field: '#F2B33D', band: '#D18F14', ink: '#2B1E05' },
  { field: '#3B2F63', band: '#251C44', ink: '#EEE9FF' },
  { field: '#1C7C66', band: '#105444', ink: '#E2F7F1' },
  { field: '#D9D3EA', band: '#B9B0D6', ink: '#241D3E' },
];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function Poster({ movie, size = 'md' }) {
  const h = hash(movie.title);
  const p = PALETTES[h % PALETTES.length];
  const bandHeight = 28 + (h % 5) * 6; // 28–52%
  return (
    <div
      className={`poster poster--${size}`}
      style={{ '--field': p.field, '--band': p.band, '--ink': p.ink, '--band-h': `${bandHeight}%` }}
      aria-hidden="true"
    >
      <span className="poster__cert">{movie.certificate}</span>
      <span className="poster__title">{movie.title}</span>
      <span className="poster__genre">{movie.genres.join(' / ')}</span>
    </div>
  );
}
