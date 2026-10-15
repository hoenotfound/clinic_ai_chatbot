# Neon Phase 2: measurement, readiness and rollback

Scope: Neutro Sense TCM, project `steep-forest-44509907`, endpoint
`ep-patient-queen-b31tib05`. **This change does not enable auto-suspend.**

## Source-of-truth checks

- Read Neon's consumption-period start/end and `compute_time_seconds / 3600`.
  Compare equal-length windows and their corresponding message volumes.
- Check endpoint `suspend_timeout_seconds`, `current_state` and
  `last_active`. On an inactive compute, avoid any manual SQL diagnostics that
  would themselves wake it during the measurement window.
- The Ops Registry client `neutro-sense-tcm` was in lifecycle `setup` with
  last poll dated September 24 at the October 15 audit. It was **not**
  participating in the registry's live five-minute background polling.
  Recheck lifecycle before attributing future wake-ups to the registry.
- Use authenticated `GET /api/ops/readiness/pool-activity` to inspect pool
  counters without issuing SQL. This endpoint requires the existing Ops
  readiness bearer token, does not refresh setup checks or call Neon, and does
  not require changing the client's lifecycle.
- A full `GET /api/ops/readiness` or manual central Ops refresh still
  performs normal PostgreSQL setup queries and can wake Neon: avoid using
  these for quiet-window measurements.
- Pool counters are in-memory, reset on process restart, and **are not a
  measurement of Neon CU-hours or the exact number of SQL queries**.

## Proposed rollout after explicit approval

1. Merge the cold-start pool PR after PostgreSQL integration and portal CI
   pass. Production Neutro currently has Render Auto-Deploy on: merging
   the client code may deploy automatically.
2. Deploy the observability PR only after its tests pass. Do not change
   registry lifecycle solely for measurements.
3. Capture a baseline of Neon's CU-hours, active time, actual suspend events,
   inbound traffic, webhook acknowledgement latency and delivery failures.
4. Test 300-second auto-suspend against an **isolated, non-production Neon
   endpoint**. Verify the compute actually reaches suspended state and cold
   queries reconnect. Repeat for WhatsApp/Messenger/Instagram inbound messages,
   bookings, outbound media, staff messages, 2h/6h/20h follow-ups, extended
   templates, comment jobs and scheduled messages. Explicitly test unknown
   Meta send outcome and Strict RM0 remains fail-closed.
5. After approval for **production** separately, enable 300 seconds for only
   the Neutro endpoint. Monitor the first cold wake and subsequent
   customer-facing message paths. Stop the experiment if incoming webhook
   acknowledgements time out, staff message sends fail, delivery attention
   rises, duplicates appear, or billing verification changes.
6. Compare equal 24-hour periods (same time-of-week when possible):
   `delta(compute_time_seconds)/3600`, customer message counts,
   latency percentiles, delivery failures, retries and missed follow-ups.
   Do not claim a saving while suspend is disabled.

## Emergency rollback

- Set the Neon endpoint `suspend_timeout_seconds` back to **0** to keep the
  compute warm. This is an operator-approved production change, not part of
  either PR.
- Revert the applicable code PR only if there is evidence its behavior caused
  the incident; check Render deployment and revert using the controlled
  deployment process.
- Do **not** resend outbound messages with uncertain Meta acceptance.
  Preserve durable message IDs, claims, consent, billing evidence and
  Strict RM0 account-wide reservations. Mark an ambiguous outcome for
  staff review.
- Validate recovery of all channel webhooks, immediate replies, Inbox media,
  booking and due follow-ups. Record time of rollback and outcome.

## Passive telemetry fields

`databasePool` contains `acquiredTotal`, `connectedTotal`,
`removedTotal`, `last5Minutes`, `last15Minutes`,
`lastAcquireAt`, `openConnections`, `idleConnections`, and
`waitingForConnection`. It contains **no SQL text, passwords, message
content, customer identifiers or background timers**. The standalone
`/api/ops/readiness/pool-activity` route has no database dependencies;
the normal full readiness route still queries Neon.
