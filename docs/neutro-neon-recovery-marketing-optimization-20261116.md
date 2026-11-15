# Neutro idle media recovery and marketing shortlist optimization (2026-11-16)

## Evidence and scope
- Production Neon: `steep-forest-44509907`, Free tier, 100 CU-hour November allowance.
- Passive Render logs on 2026-11-15 17:03–22:38 UTC recorded 1,079 pool acquisitions labeled "Secondary WhatsApp AI media recovery" among 2,663 total, including extended periods of roughly 20 acquisitions every five minutes without WhatsApp ingress.
- Those acquisition counts are NOT billed CU-hours and do not prove the queue is empty. No production SQL was run or compute deliberately awakened for this review.
- Source analysis shows `hasPendingWork` returns true for any durable `pending` job, including jobs deferred to a future attempt and during forbidden sending hours. This keeps the one-minute recovery loop alive.

## Proposed media scheduler
- Use one sender-bound read of pending/claimed job state and the earliest pending retry deadline after each sweep.
- Keep immediate durable enqueue and verified receipt wakes; retain the original one-minute cadence for `claimed` attempts and due work, as well as one-minute retry after scheduler errors.
- Sleep until the next retry for deferred `pending` jobs, at most one hour. During Malaysia's 00:00–06:59 quiet hours, do not use pending-only jobs to wake every minute; check at most hourly and at 07:00 so the first permitted send is not delayed.
- Retain startup sweep, stale claim quarantine, expiry cancellation, signed provider outcome and billing safeguards. The patch does not bypass send authorizations, change treatment eligibility or resend uncertain outcomes.

## Proposed marketing shortlist
- Filter the materialized `recent_seed` using the already-required sender account, channel and active status. The outer sender-bound conversation, consent, booking, opt-out, staff, treatment, template approval, billing and one-shot checks remain unchanged.
- This is a **candidate performance hypothesis, not a measured SQL improvement**. The previous isolated staging benchmark found marketing candidates were still slow after migration 132. This filter must be compared with the previous query on an isolated, explicitly approved staging database before release.

## Required release gates
1. Run focused unit tests and PostgreSQL integration tests, including secondary media, billing, marketing, sender isolation and due-hint SQL compilation. Confirm all CI jobs pass.
2. Benchmark marketing candidate/due/recheck queries against the identical prior query and representative test data. Require the same eligible contact IDs, slot/language and recheck result, with no performance regression, before enabling the marketing change in production.
3. With synthetic events, exercise midnight, 06:59, 07:00, future retries, next-attempt expiry, inbound media enqueue, signed receipts, claimed/unknown outcomes, opt-outs, appointments and both senders.
4. Only after review, merge intentionally and deploy once, using manual Render deployment. Verify first customer replies and media, marketing/service follow-up jobs, provider receipts, staff takeover, appointments, and error rates.
5. Compare comparable 24-hour Neon CU-hours and pool activity before and after. Do not claim savings from traffic differences or raw pool acquisitions.

## Rollback
Revert only this worker scheduling/seed change if media is late or marketing parity/performance regresses. Retain the migration 132 index and all existing Meta billing/consent protections. Neither PR creation nor merging changes the running Render service while auto-deploy is disabled.
