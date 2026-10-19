export type Role = 'USER' | 'ADMIN';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Movie {
  id: string;
  title: string;
  description: string;
  durationMins: number;
  languages: string[];
  genres: string[];
  certificate: 'U' | 'UA' | 'A';
  releaseDate: string;
}

export type SeatCategory = 'REGULAR' | 'PREMIUM' | 'RECLINER';
export type Prices = Partial<Record<SeatCategory, number>>;

export interface ShowtimeGroup {
  venue: { id: string; name: string; address: string };
  shows: { id: string; startsAt: string; screenName: string; minPrice: number; prices: Prices }[];
}

export interface LayoutSection {
  category: SeatCategory;
  rows: string[];
  seatsPerRow: number;
  aisleAfter: number[];
}

export interface ShowDetails {
  id: string;
  startsAt: string;
  endsAt: string;
  status: 'SCHEDULED' | 'CANCELLED';
  prices: Prices;
  movie: Movie;
  venue: { id: string; name: string; city: string; address: string };
  screen: { id: string; name: string; layout: { sections: LayoutSection[] } };
}

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'HELD_BY_YOU' | 'BOOKED';
export interface Seat {
  seatId: string;
  row: string;
  number: number;
  category: SeatCategory;
  price: number;
  status: SeatStatus;
}

export interface LineItem {
  kind: 'TICKET' | 'SURCHARGE' | 'DISCOUNT' | 'FEE' | 'TAX';
  code: string;
  label: string;
  amount: number;
}
export interface PriceBreakdown {
  items: LineItem[];
  ticketTotal: number;
  discount: number;
  fees: number;
  taxes: number;
  total: number;
}

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
export interface Booking {
  id: string;
  showId: string;
  status: BookingStatus;
  seats: string[];
  amount: number;
  currency: string;
  priceBreakdown: PriceBreakdown;
  couponCode: string | null;
  expiresAt: string;
  paymentId: string | null;
  statusReason: string | null;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  show?: { movieTitle: string; venueName: string; screenName: string; city: string; startsAt: string };
}

export interface SeatMapResponse {
  show: { id: string; movieTitle: string; venueName: string; screenName: string; city: string; startsAt: string; status: string };
  seats: Seat[];
  myHold: Booking | null;
  maxSeatsPerBooking: number;
}

export interface Payment {
  id: string;
  bookingId: string;
  amount: number;
  provider: 'mock' | 'razorpay';
  status: 'CREATED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'REFUNDED';
  failureReason: string | null;
  refundReason: string | null;
  checkout?: { mode: 'mock' | 'razorpay'; orderId: string; keyId?: string; amount?: number; currency?: string };
}

export interface Notice {
  id: string;
  kind: 'success' | 'info' | 'warning';
  title: string;
  text: string;
  at: string;
}
