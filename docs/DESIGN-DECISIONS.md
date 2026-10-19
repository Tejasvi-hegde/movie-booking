# Design decisions & trade-offs

These are the questions interviewers actually ask about a project like this, with the reasoning behind each choice and what was given up.

### Why lock seats in Redis instead of just using the database?

Holds are short-lived, extremely contended (everyone clicks the centre seats the minute bookings open) and must vanish on their own if a user closes the tab. A Redis key with a TTL does all three cheaply, and a Lua script makes "lock all these seats or none" atomic.

The trade-off is that Redis is not durable in the same way Postgres is. That is acceptable because Redis only answers "is someone in the middle of buying this?". The authoritative "who owns this seat" lives in Postgres, guarded by a conditional `UPDATE … WHERE status = 'AVAILABLE'` under row locks. Even if Redis lost every key, the worst case is that two people reach payment for the same seat. One gets confirmed and the other is automatically refunded. Nobody is double-booked.

### Why not `SELECT … FOR UPDATE` on the seats for the whole hold?

A database row lock is held only for the length of a transaction. A hold lasts 5 minutes while the user types card details, and you cannot keep a transaction open that long. The alternative would be a `held_until` column, which works but turns every seat-map read and every expiry into database writes on the busiest table.

### Why is the Redis lock TTL longer than the hold?

The hold is 5 minutes, and the lock lives for 5 minutes plus a 60-second grace period. If a payment completes at 4:59 and its webhook arrives at 5:10, the seats must still be ours. Without the grace period another user could grab them in that window, and the first payment would end in a refund.

### Why a saga instead of a distributed transaction (2PC)?

The payment provider is an external company: you cannot enlist Razorpay in a two-phase commit. Even between our own services, 2PC couples availability (every participant must be up) and holds locks across the network. A saga makes each step a local transaction and defines a compensating action for failure (refund). The trade-off is temporary inconsistency: for a moment a payment is `SUCCEEDED` while the booking is still `PENDING`. The UI shows "Confirming your seats…" for that window.

### Orchestration or choreography?

Mostly choreography (services react to each other's events), with booking acting as the decision-maker for the booking lifecycle. Booking is the only service that decides "confirm" or "refund". Payment just does what booking's events ask. That keeps the business rule in one place without a separate orchestrator service.

### Why the transactional outbox?

"Commit to the DB, then publish the event" is two writes to two systems. A crash in between leaves a confirmed booking that nobody hears about, so no ticket email and, worse, no refund. Writing the event into an `outbox` table in the same transaction makes the two atomic. The cost is at-least-once delivery (a crash after publishing but before marking the row re-sends it), so every consumer must be idempotent, and they are.

### Why Redis Streams and not Kafka or RabbitMQ?

The project already needs Redis (locks, cache, rate limiting), and Streams give consumer groups, acknowledgements, pending-entry lists for retries, and replay from any offset. That covers what this system needs without running another broker. The `EventPublisher`/`EventConsumer` classes are the seam: on AWS this becomes SQS/SNS. At much larger scale, Kafka would give partitioned ordering and long retention.

### Why idempotency keys if the payment is already unique per booking?

They protect different things. The partial unique index guarantees one open payment per booking even across different keys. The idempotency key makes a retried request return the exact same response (same payment id, same checkout details) instead of an error, which matters for mobile clients that time out and retry. It also catches client bugs: the same key with a different body returns 422.

### Why does the gateway verify JWTs instead of every service?

The signature is checked once, and services receive trusted identity headers. To keep that safe, the gateway strips any `x-user-*` headers the client sent, and services reject any request without the internal token, so nobody can call a service directly and claim to be someone else. Authorization (does this booking belong to you?) stays in each service, next to its data.

The trade-off is that the internal network must be trusted. In production you would add mTLS between services (a service mesh does this).

### Why refresh-token rotation with reuse detection?

Access tokens live 15 minutes in memory, never in localStorage where XSS could read them. Refresh tokens live in an httpOnly cookie. Each refresh issues a new refresh token and revokes the old one. If a revoked token is used again, someone has a copy, so the whole login session is revoked.

Known trade-off: two browser tabs refreshing at the exact same moment can trigger this. The frontend de-duplicates refreshes within a tab. A short grace window would fix the cross-tab case.

### Why MongoDB for the catalog?

Venue layouts are nested documents (screens → sections → rows), shapes vary between venues, and the catalog is read-heavy with no multi-document transactions. Bookings and payments are the opposite: they need ACID transactions and constraints, so they use Postgres. One project showing both, each with a reason, is a deliberate choice.

The catalog publishes events without a multi-document transaction by **embedding the outbox in the show document**. Single-document writes are atomic in MongoDB, so the show and its `show.created` event are saved together.

### Why a sliding-window rate limiter instead of a fixed window?

A fixed window of "10 per minute" allows 20 requests in two seconds across a window boundary. A sliding log in a sorted set counts the actual last 60 seconds. It costs more memory per client (one entry per request), which is fine at these limits. If Redis is down, the limiter **fails open**: losing rate limiting briefly is better than losing the whole site.

### What would you change for real scale?

- A virtual waiting room in front of the seat map for blockbuster openings, to smooth spikes before they reach booking
- Partitioning booking data by show (hot shows on dedicated shards)
- Separate Redis clusters for locks, cache and streams, so a cache stampede cannot starve the locks
- OpenTelemetry traces across services, alerting on DLQ length and outbox lag
- mTLS between services
