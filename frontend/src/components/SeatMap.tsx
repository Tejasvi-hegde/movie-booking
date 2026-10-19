import { rupees } from '../lib/format';
import type { LayoutSection, Seat, SeatCategory } from '../lib/types';

const CATEGORY_NAME: Record<SeatCategory, string> = { REGULAR: 'Regular', PREMIUM: 'Premium', RECLINER: 'Recliner' };

const STATUS_LABEL: Record<Seat['status'] | 'SELECTED', string> = {
  AVAILABLE: 'available',
  SELECTED: 'selected',
  HELD: 'being booked by someone else',
  HELD_BY_YOU: 'held by you',
  BOOKED: 'sold',
};

interface Props {
  sections: LayoutSection[];
  seats: Seat[];
  selected: Set<string>;
  onToggle: (seat: Seat) => void;
  flash?: Set<string>;
}

/**
 * The auditorium. Sections are drawn back-to-front as the layout lists them, with the screen
 * at the bottom, the way you see it walking in from the back. Each seat is a real button.
 */
export function SeatMap({ sections, seats, selected, onToggle, flash }: Props) {
  const byId = new Map(seats.map((s) => [s.seatId, s]));
  // Premium/recliner rows sit at the back in most halls; draw last section first.
  const ordered = [...sections].reverse();

  return (
    <div className="auditorium">
      <div className="auditorium__scroll">
        <div className="auditorium__hall">
          {ordered.map((section) => {
            const price = seats.find((s) => s.category === section.category)?.price;
            return (
              <section key={section.category} className="hall-section" aria-label={`${CATEGORY_NAME[section.category]} seats`}>
                <h3 className="hall-section__label">
                  {CATEGORY_NAME[section.category]}
                  {price !== undefined && <span>{rupees(price)}</span>}
                </h3>
                {[...section.rows].reverse().map((row) => (
                  <div key={row} className="seat-row">
                    <span className="seat-row__label">{row}</span>
                    <div className="seat-row__seats">
                      {Array.from({ length: section.seatsPerRow }, (_, i) => i + 1).map((n) => {
                        const seat = byId.get(`${row}${n}`);
                        const gap = section.aisleAfter.includes(n);
                        if (!seat) return <span key={n} className={`seat seat--void ${gap ? 'seat--gap' : ''}`} />;
                        const isSelected = selected.has(seat.seatId);
                        const state = isSelected ? 'SELECTED' : seat.status;
                        const disabled = !isSelected && (seat.status === 'BOOKED' || seat.status === 'HELD');
                        return (
                          <button
                            key={n}
                            type="button"
                            className={`seat seat--${state.toLowerCase().replace('_', '-')} seat--${seat.category.toLowerCase()} ${gap ? 'seat--gap' : ''} ${flash?.has(seat.seatId) ? 'seat--flash' : ''}`}
                            aria-pressed={isSelected}
                            aria-label={`Row ${row}, seat ${n}, ${CATEGORY_NAME[seat.category]} ${rupees(seat.price)}, ${STATUS_LABEL[state]}`}
                            disabled={disabled}
                            onClick={() => onToggle(seat)}
                          >
                            <span aria-hidden="true">{n}</span>
                          </button>
                        );
                      })}
                    </div>
                    <span className="seat-row__label">{row}</span>
                  </div>
                ))}
              </section>
            );
          })}
          <div className="screen" aria-hidden="true">
            <span>Screen this way</span>
          </div>
        </div>
      </div>
      <ul className="legend">
        <li><span className="seat seat--available seat--legend" />Available</li>
        <li><span className="seat seat--selected seat--legend" />Your pick</li>
        <li><span className="seat seat--held seat--legend" />Someone is booking</li>
        <li><span className="seat seat--booked seat--legend" />Sold</li>
      </ul>
    </div>
  );
}
