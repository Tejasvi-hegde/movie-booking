CREATE TABLE payments (
  id                  UUID PRIMARY KEY,
  booking_id          UUID NOT NULL,
  user_id             TEXT NOT NULL,
  user_email          TEXT,
  amount              INT NOT NULL CHECK (amount >= 0),
  currency            TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_order_id   TEXT NOT NULL,
  provider_payment_id TEXT,
  status              TEXT NOT NULL CHECK (status IN ('CREATED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED')),
  failure_reason      TEXT,
  refund_id           TEXT,
  refund_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_order_uq ON payments (provider, provider_order_id);
CREATE INDEX payments_booking_idx ON payments (booking_id);
-- At most one open payment attempt per booking, enforced by the database rather than by hope.
CREATE UNIQUE INDEX payments_one_open_per_booking ON payments (booking_id) WHERE status = 'CREATED';

-- Providers retry webhooks until they get a 2xx, so the same event can arrive many times.
-- Recording the event id in the same transaction as its effect makes processing exactly-once.
CREATE TABLE webhook_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

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
