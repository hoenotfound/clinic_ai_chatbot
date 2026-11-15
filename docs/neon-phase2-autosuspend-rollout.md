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

## 15 November 2026: measured idle recovery wake reduction

Read-only production baseline (project `steep-forest-44509907`, Free tier):

- Neon alert: 80.1 of 100 CU-hours used for November, with reset on December 1 UTC.
- Endpoint API reports `suspend_timeout_seconds: 0` but operation history
  **confirms successful Free-tier suspensions and restarts**. Do not toggle
  autosuspend based on the numeric field alone.
- Render was confirmed to deploy manually (`autoDeploy: no`), so opening or
  merging a PR does not change production by itself.
- The secondary AI media recovery worker ran just after compute starts at
  2026-11-15 01:09:49 UTC and 01:39:50 UTC. Its default empty queue check was
  every 30 minutes, and a read-only SQL snapshot found zero pending/claimed
  secondary media jobs (212 accepted, 36 expired).
- Other expensive SQL observed: secondary service/marketing follow-up candidate
  and next-due queries around 0.7–1.3 seconds per execution since the most
  recent pg_stat_statements reset. These remain subject to separate index/plan
  review: avoid changing eligibility logic or follow-up timing on a cost guess.

This patch changes **only** the empty-queue fallback for
`whatsappSecondaryAiMediaQueue` and `whatsappCoexistenceMutationService`
from 30 to 60 minutes. It preserves the existing generic worker default,
immediate enqueue/receipt/echo wakes, and 60-second cadence when actionable
work exists. An orphaned job with no event wake can be discovered up to
30 minutes later than before. Do not apply that tradeoff to primary follow-ups,
marketing, staff appointment reminders, Meta billing or provider retries.

Validation before a deliberate manual Render deployment:

1. Run `node --test test/secondaryIdleRecoveryOptimization.test.js` and the
   related secondary media, mutation, follow-up and billing suites.
2. Confirm the PR's full CI jobs passed before merging.
3. After deployment, check actual inbound replies, both WhatsApp numbers,
   media queue creation, edits/revocations, booked-contact suppression and
   follow-up delivery, not just the lack of error logs.
4. Compare equivalent 24-hour windows of billed CU-hours, compute
   start/suspend operations, DB activity, and customer traffic. Do not
   report projected savings as observed savings.
5. If orphaned work recovery is unacceptably delayed, remove the two
   `emptyIntervalMs:60*60*1000` overrides to restore the previous 30-minute
   safety fallback without changing any sending policy.


## 15 November 2026: verified Business App idle recovery and follow-up batch optimization

A follow-up review found two remaining fixed one-minute database recovery
loops in the *optional* Business App echo-media downloader and consented
history importer. These should not wake the Free-tier compute when no work
is queued. This change is independent of the already deployed PR #634.

- Both workers start with an immediate recovery pass after a Render restart.
- Only a verified, durably stored media job or signed history import wakes
  its corresponding worker immediately. Existing duplicate receipts are safe.
- Pending/claimed media and pending/processing history jobs preserve the
  **one-minute** retry/recovery cadence. Failed queue status inspection also
  retries after one minute; missing query results never mean "empty".
- Empty queues use a **60-minute** lost-event backstop instead of fixed
  one-minute polling. If a durable enqueue was saved but its in-process wake
  was lost, the orphan may be discovered up to an hour later. This is a
  deliberate tradeoff: roll back the two hourly overrides if observed
  Business App attachment/history recovery is too slow.
- Staff Inbox appointment-reminder repair retains its immediate error-path
  wake and the original **30-minute** lost-event safety interval. The more
  aggressive 60-minute change was removed after review to protect bookings.
- When a secondary follow-up sweep attempts 10 or more jobs, it already
  schedules a new sweep in ten seconds. Skip the read-only due-time hint in
  that one case, because the existing scheduler would discard its result.
  Smaller batches, booked/opted-out changes, consent checks, quiet hours
  and all billing rules remain unchanged.
- Verified successful delivery updates on already-created *automated*
  secondary follow-up messages are tagged as presentation-only for the
  secondary due-time schedulers. The Inbox still receives them. **Do not
  suppress** first AI/staff reply receipts, the 131060 recovery menu, FEP
  pricing evidence, failed delivery outcomes, unknown/unverified sender
  receipts, bookings, opt-outs, customer messages or rule changes. The
  existing three-second receipt scheduling stays unchanged for all eligible
  events.
- A single startup log records **actual** worker-start booleans for
  optional Business App echo-media, optional consented history, secondary
  service follow-ups and marketing follow-ups. It contains no secrets, phone
  numbers or customer data. Before deployment, whether each optional worker
  is enabled in the live Render environment cannot be established from
  an absence of worker-duration log entries alone.

Verification: run
`node --test test/secondaryIdleRecoveryOptimization.test.js test/secondaryDueTimeScheduler.test.js test/whatsappCoexistenceMediaService.test.js test/whatsappCoexistenceHistoryService.test.js test/whatsappDeliveryStatusService.test.js`
plus the repository's remaining CI suites. Test with synthetic event payloads
and an isolated database, never by replaying production customer sends.

Release: leave manual Render deploy disabled until CI and PR review finish.
After a deliberate deployment, compare same-traffic 24-hour periods of billed
CU-hours, compute starts, and worker outcomes. Confirm secondary echo
attachments, staff app history import, both WhatsApp numbers, booking
recording and due follow-ups before claiming savings. No production SQL,
Neon settings, customer data, or messages are required for code review.
