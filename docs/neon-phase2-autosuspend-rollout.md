# Neon Phase 2: production scale-to-zero and idle worker readiness

Scope: Neutro Sense TCM, Neon project `steep-forest-44509907`,
endpoint `ep-patient-queen-b31tib05`.

## Free-plan scale-to-zero is mandatory

Neutro uses Neon's Free plan. The current Neon guidance states that Free
computes suspend after approximately five minutes of inactivity, and disabling
scale-to-zero requires a paid plan:

- https://neon.com/docs/introduction/scale-to-zero
- https://neon.com/docs/guides/scale-to-zero-guide

**Do not interpret `suspend_timeout_seconds: 0` as evidence of an always-on
compute on the Free plan.** The API can report `0` while Free-plan suspension
is enforced. Interpret this value together with the plan, endpoint state, and
`start_compute` / `suspend_compute` operation history; do not page solely
because a Free compute suspended or restarted after an idle period.

On October 16, the production endpoint was observed suspending and starting
repeatedly overnight. All retrieved operations finished successfully. That
was not evidence of a crash or a manually initiated suspension. The cause of
each subsequent wake-up was not individually established.

## Source-of-truth monitoring (read-only)

- Read the consumption period and `compute_time_seconds / 3600` as CU-hours.
  Alert on *new* 90/95/100 CU-hour threshold crossings or an evidenced
  projection to 100 CU-hours in the next 24 hours.
- Read endpoint `current_state`, `suspend_timeout_seconds` and `last_active`.
  Review Neon operation `action`, `status`, `failures_count` and timestamps.
  On Free, normal suspend/start operations are expected; investigate failed
  starts, excessive wake-ups, prolonged unavailable periods and customer impact.
- Check Render deployment, service events, application/request logs, 5xx counts,
  memory and restarts. An absence of errors does **not** demonstrate delivery of
  individual WhatsApp/Messenger/Instagram messages or due follow-ups.
- On an idle compute, do not run manual SQL diagnostics during a cost baseline.
  Such queries wake the compute and invalidate idle measurements.
- The Ops Registry client `neutro-sense-tcm` was in lifecycle `setup` with
  last poll dated September 24 at the October 15 audit. Recheck its lifecycle
  before attributing subsequent wake-ups to its registry background polling.
- Prefer the authenticated `GET /api/ops/readiness/pool-activity` endpoint to
  inspect **passive** pool counters; it requires the existing Ops readiness
  bearer token and does not query Neon. The full
  `GET /api/ops/readiness` endpoint or manual setup refresh can issue SQL and
  wake a sleeping compute. Do not use them during passive cost monitoring.

## Idle safety wake optimization

Phase 2 removed multiple constant short-interval polling loops, but four
safety loops could still wake an otherwise idle Neon database every 15 minutes.
The next optimization extends **empty-queue safety checks** to one hour in:

- WhatsApp delivery-status recovery
- Strict RM0 optional result/promotion image queue
- Meta comment recovery
- WhatsApp extended follow-up scheduler

This is **not** a one-hour retry for active work. Preserve immediate webhook
processing/event wake signals, exact pending retry and stale-lease deadlines,
the initial startup recovery sweep, delivery-status fast retries, billing
alerts, and five-minute transient template-policy retries. Do not change
customer quiet hours, Meta pricing safeguards, or billing acceptance rules.

The remaining hourly sweep exists to recover rare lost wake signals or jobs
persisted without an event. Such orphaned jobs may be discovered **later,
potentially up to an hour** instead of 15 minutes. If operational evidence
shows this fallback delay is unacceptable, roll back the idle interval change
rather than removing it or blindly re-sending unknown-outcome messages.
`whatsapp_result_media_queue` optional images retain their independent
expiry and cannot safely be sent after expiry.

Do not claim CU-hour savings until comparing equivalent traffic periods after
deployment. Hourly timers can still overlap with other queries or workers,
and elapsed wake windows do not by themselves measure billed compute.

## Verification and controlled rollout

1. Run syntax checks and regression tests for empty queues, due work, retries,
   stale-lease recovery, event wakes, and Meta strict-RM0 safeguards.
2. Validate end-to-end cold-start behavior using an isolated test Neon project
   before treating worker reconnection evidence as customer-facing proof.
   Exercise WhatsApp/Messenger/Instagram, follow-ups, media sends, staff
   handoff and ambiguous provider outcomes.
3. Review the PR and CI before merging. The Neutro Render service can
   auto-deploy from `main`: merge only when ready to change production.
4. On production, compare equivalent 24-hour intervals using Neon compute
   usage, the number/timing of compute starts, and customer activity. Observe
   Render logs and worker errors; verify timely delivery and follow-up job
   completion through separate supported operational checks.
5. Treat Free-plan scale-to-zero as expected. Escalate if the endpoint does
   not restart, connection timeouts increase, worker jobs become overdue,
   message delivery evidence fails, or compute usage crosses thresholds.

## Emergency rollback

- Revert the **idle safety interval** code change if orphan recovery is too
  slow or a channel/follow-up regression appears. The prior safety backstop
  was 15 minutes. Keep error-retry and provider-idempotency safeguards intact.
- Do **not** attempt to disable Free-plan scale-to-zero by setting
  `suspend_timeout_seconds` to `0`. Always-on compute requires a supported
  paid plan and an explicit operator-approved change.
- Do **not** resend uncertain WhatsApp/Meta provider outcomes; retain durable
  message IDs, retry claims, consent, billing evidence and Strict RM0
  reservations. Flag ambiguous outcomes for staff review.
- Validate recovery of webhooks, Inbox media, bookings and due follow-ups.
  Record any rollback time and outcome.

## Passive pool telemetry

`databasePool` contains `acquiredTotal`, `connectedTotal`,
`removedTotal`, `last5Minutes`, `last15Minutes`,
`lastAcquireAt`, `openConnections`, `idleConnections`,
`waitingForConnection`, and a limited `bySource` summary. It contains
no SQL text, passwords, message content, customer identifiers, or
background timers.

`bySource` is best-effort: an acquired pool connection is **not necessarily**
a new TCP connection or a Neon wake-up. Counters reset on Render process
restart. Compare named activity with Neon operations and measured CU-hours
without inducing database activity during the observation window.
