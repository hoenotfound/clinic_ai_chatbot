# Neutro Neon background-worker optimization, 2026-11-23

## Read-only production baseline
- Production Neon: `delicate-credit-82369573`, no production mutation in this review.
- The extended Day4/Day6 potential-due SQL was the top measured query:
  58 calls / about 80.4 seconds execution time, around 1.39s per call
  in the previous read-only PostgreSQL statistics window; a later sample
  showed 14 calls / 26.8 seconds, 1.92s per call.
- Roughly 9,247 signed status receipts existed on 2026-11-23. There was no
  `(sender_id, wamid)` index, though the seven-day verified-ad session uses
  that exact join for delivered, free-entry, nonbillable provider proof.
- Render pool logs also showed frequent FEP and staff-waiting wake-ups.
  Pool acquisitions are **not** Neon CU-hours. No CU saving is assumed.

## Changes
1. Migration **135** adds a read-only lookup index on
   `whatsapp_sender_status_receipts(sender_id, wamid)`. It neither changes
   existing receipts nor authorizes any message. The migration runner uses
   a transaction and advisory lock, so nonconcurrent index creation is
   required; 8-second bounded lock and 60-second statement timeouts keep
   a busy deployment from blocking indefinitely.
2. The Day4/Day6 candidate and due-time hint scans are seeded from
   `whatsapp_free_entry_referrals` with nonblank ad identifiers and a
   real WhatsApp inbound origin younger than **eight days**. An eligible
   free-entry reply occurs within 24h after origin and the original seven-day
   session requires reply to be at most 167h old, giving a maximum origin
   age of 191h. Eight days (192h) is a conservative superset, not a new
   eligibility test. The full sender-owned signed reply/receipt, consent,
   treatment, booking, opt-out, staff, alarm, billing, no-duplicate and
   pre-send checks remain untouched.
3. The independent WhatsApp free-entry follow-up worker ignores only:
   reactions, explicitly presentation-only automated delivery receipts,
   and the same three proven CRM-only pipeline reasons already excluded by
   primary/secondary follow-up workers. No channel-only suppression:
   booking, opt-out, real message, unverified receipt, provider billing proof,
   appointment and configuration events still wake on the original schedule.
4. Staff waiting alert workers coalesce multiple *synchronous* message
   changes into one microtask wake, with no timer/due change. Later messages,
   startup recovery, ten-minute waiting thresholds and retries still work.

## Testing and rollout
- CI must run all backend tests, isolated migrated PostgreSQL billing +
  `EXPLAIN` for ordinary, extended and batched hints, portal and browser.
  A specific integration assertion checks that migration 135 creates the
  new index on a disposable schema. No real Meta send is performed in CI.
- Check the last `schema_migrations` version and existing database branch
  before rollout. The migration runner's transaction lock can fail fast on
  high traffic; prefer a quiet deployment period and do not alter the
  production database outside the normal approved migration process.
- Only after a deliberate deployment, compare **like-for-like 24h**
  `pg_stat_statements` mean/total latency and calls for the extended
  due hint; Render pool activity for FEP, staff alerts and secondary
  schedulers; and actual billed Neon CU-hours / compute starts.
- Confirm normal first messages, both WhatsApp numbers, 2h/6h/20h and
  Day4/Day6, consented general follow-ups, media, Meta 131060, pricing
  graphic pairs, staff waiting alerts, booking/opt-out cancellations and
  billing holds. Never resend an uncertain provider attempt.
- Roll back app code if there are missed follow-ups or unexpected SQL errors;
  a harmless additive index can stay installed. Do not roll back historical
  migration files or manually alter applied checksums.

### Not modified
The primary worker's overdue retry cadence, secondary AI media recovery's
one-minute **claimed/unknown** send protection, staff booking recovery,
telegram retry queue and inbound customer replies. These paths have real
customer or billing consequences; optimize further only with isolated
before/after tests and production measurements.
