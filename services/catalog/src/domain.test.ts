import { describe, expect, it } from 'vitest';
import { generateSeats, istDayRange, overlaps, showEndsAt, type SeatLayout } from './domain.js';

const layout: SeatLayout = {
  sections: [
    { category: 'REGULAR', rows: ['A', 'B'], seatsPerRow: 3, aisleAfter: [] },
    { category: 'RECLINER', rows: ['C'], seatsPerRow: 2, aisleAfter: [] },
  ],
};

describe('generateSeats', () => {
  it('expands sections into priced seats with row+number ids', () => {
    const seats = generateSeats(layout, { REGULAR: 100, RECLINER: 300 });
    expect(seats).toHaveLength(8);
    expect(seats[0]).toEqual({ seatId: 'A1', row: 'A', number: 1, category: 'REGULAR', price: 100 });
    expect(seats.at(-1)).toEqual({ seatId: 'C2', row: 'C', number: 2, category: 'RECLINER', price: 300 });
  });

  it('requires a price for every category in the layout', () => {
    expect(() => generateSeats(layout, { REGULAR: 100 })).toThrow(/RECLINER/);
  });

  it('rejects a row used in two sections', () => {
    const bad: SeatLayout = { sections: [layout.sections[0]!, { ...layout.sections[1]!, rows: ['B'] }] };
    expect(() => generateSeats(bad, { REGULAR: 1, RECLINER: 1 })).toThrow(/Row B/);
  });
});

describe('show scheduling', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));

  it('computes the end time from the movie duration', () => {
    expect(showEndsAt(at(10), 150)).toEqual(at(12, 30));
  });

  it('detects overlap including the cleaning buffer', () => {
    // 10:00–12:30, next show 12:40 → within 15-minute buffer → overlap
    expect(overlaps(at(10), at(12, 30), at(12, 40), at(15))).toBe(true);
    // next show 12:45 → exactly at buffer end → fine
    expect(overlaps(at(10), at(12, 30), at(12, 45), at(15))).toBe(false);
    // symmetric
    expect(overlaps(at(12, 45), at(15), at(10), at(12, 30))).toBe(false);
  });

  it('builds IST day windows', () => {
    const { from, to } = istDayRange('2026-10-20');
    expect(from.toISOString()).toBe('2026-10-19T18:30:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(86_400_000);
  });
});
