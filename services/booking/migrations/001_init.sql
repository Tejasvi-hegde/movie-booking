-- Local read model of shows, built from catalog's show.created events. Owning a copy means
-- booking never has to call catalog synchronously on the hot path (database-per-service).
CREATE TABLE shows (
  show_id      TEXT PRIMARY KEY,
  movie_id     TEXT NOT NULL,
  movie_title  TEXT NOT NULL,
  venue_id     TEXT NOT NULL,
  venue_name   TEXT NOT NULL,
  city         TEXT NOT NULL,
  screen_name  TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  timezone     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seat inventory: the source of truth for what is SOLD.
-- (Temporary holds live in Redis; see seat-lock.js.)
CREATE TABLE show_seats (
  show_id     TEXT NOT NULL REFERENCES shows (show_id),
  seat_id     TEXT NOT NULL,
  row_label   TEXT NOT NULL,
  seat_number INT  NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('REGULAR', 'PREMIUM', 'RECLINER')),
  price       INT  NOT NULL CHECK (price >= 0),
  status      TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'BOOKED')),
  booking_id  UUID,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (show_id, seat_id),
  -- A booked seat always points at its booking, and an available one never does.
  CONSTRAINT booked_has_booking CHECK ((status = 'BOOKED') = (booking_id IS NOT NULL))
);
CREATE INDEX show_seats_booking_idx ON show_seats (booking_id) WHERE booking_id IS NOT NULL;

CREATE TABLE bookings (
  id              UUID PRIMARY KEY,
  user_id         TEXT NOT NULL,
  user_email      TEXT NOT NULL,
  user_name       TEXT NOT NULL,
  show_id         TEXT NOT NULL REFERENCES shows (show_id),
  status          TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'CANCELLED')),
  seat_ids        TEXT[] NOT NULL,
  amount          INT NOT NULL CHECK (amount >= 0),
  currency        TEXT NOT NULL DEFAULT 'INR',
  price_breakdown JSONB NOT NULL,
  coupon_code     TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  payment_id      UUID,
  status_reason   TEXT,
  version         INT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_show_idx ON bookings (show_id, status);
-- The expiry sweeper only ever scans pending bookings: keep that index tiny.
CREATE INDEX bookings_pending_expiry_idx ON bookings (expires_at) WHERE status = 'PENDING';
-- A user can hold seats for a show only once at a time.
CREATE UNIQUE INDEX bookings_one_pending_per_user_show ON bookings (user_id, show_id) WHERE status = 'PENDING';

CREATE TABLE outbox (
  id           UUID PRIMARY KEY,
  seq          BIGSERIAL,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished_idx ON outbox (seq) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  user_id         TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status INT,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
