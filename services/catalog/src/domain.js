import { BadRequestError } from '@showtime/common';
import { z } from 'zod';

export const SEAT_CATEGORIES = ['REGULAR', 'PREMIUM', 'RECLINER'];

export const layoutSectionSchema = z.object({
  category: z.enum(SEAT_CATEGORIES),
  rows: z
    .array(z.string().regex(/^[A-Z]{1,2}$/, 'Row labels are 1–2 capital letters'))
    .min(1)
    .max(26),
  seatsPerRow: z.number().int().min(1).max(40),
  /** Seat numbers after which an aisle gap is drawn (purely visual). */
  aisleAfter: z.array(z.number().int().min(1)).default([]),
});
export const seatLayoutSchema = z.object({ sections: z.array(layoutSectionSchema).min(1).max(5) });

/** Cleaning + ad break buffer between back-to-back shows on one screen. */
export const SHOW_BUFFER_MINUTES = 15;

/**
 * Expands a screen layout into concrete seats priced for one show.
 * Seat ids are row + number ("A7") — stable, human readable and unique per screen.
 */
export function generateSeats(layout, prices) {
  const seen = new Set();
  const seats = [];
  for (const section of layout.sections) {
    const price = prices[section.category];
    if (price === undefined) throw new BadRequestError(`No price set for ${section.category} seats`);
    for (const row of section.rows) {
      if (seen.has(row)) throw new BadRequestError(`Row ${row} appears in more than one section`);
      seen.add(row);
      for (let n = 1; n <= section.seatsPerRow; n++) {
        seats.push({ seatId: `${row}${n}`, row, number: n, category: section.category, price });
      }
    }
  }
  return seats;
}

export function categoriesIn(layout) {
  return [...new Set(layout.sections.map((s) => s.category))];
}

export function showEndsAt(startsAt, durationMins) {
  return new Date(startsAt.getTime() + durationMins * 60_000);
}

/** True when two shows on the same screen would overlap (including the cleaning buffer). */
export function overlaps(aStart, aEnd, bStart, bEnd, bufferMins = SHOW_BUFFER_MINUTES) {
  const buffer = bufferMins * 60_000;
  return aStart.getTime() < bEnd.getTime() + buffer && bStart.getTime() < aEnd.getTime() + buffer;
}

/** Day window for a YYYY-MM-DD date in India Standard Time (all demo venues are in India). */
export function istDayRange(date) {
  const from = new Date(`${date}T00:00:00+05:30`);
  if (Number.isNaN(from.getTime())) throw new BadRequestError('date must be YYYY-MM-DD');
  return { from, to: new Date(from.getTime() + 86_400_000) };
}
