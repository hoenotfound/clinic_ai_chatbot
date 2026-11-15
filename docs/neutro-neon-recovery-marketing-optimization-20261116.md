# Neutro secondary AI media recovery: CU optimization (2026-11-16)

## Observed production activity
- Passive Render logs from 2026-11-15 17:03–22:38 UTC showed 1,079 database pool acquisitions attributed to the "Secondary WhatsApp AI media recovery" worker, out of 2,663 total.
- During Malaysia's 00:00–06:59 quiet hours, this worker repeatedly recorded approximately 20 acquisitions every five minutes despite little incoming WhatsApp traffic.
- Pool acquisitions are not billed compute CU-hours, nor proof that any queue is empty. No production SQL or production data mutations were used in this analysis.

## Media recovery change
- The original `hasPendingWork()` response returned true for every `pending` or `claimed` media job, even when pending work could not be retried until later, causing one-minute polling.
- The new scheduler checks the earliest `pending.next_attempt_at` after completing a recovery sweep. Deferred jobs wait until their deadline, with an hourly lost-wake fallback.
- Within Malaysia's 00:00–06:59 quiet hours, pending-only jobs use the hourly fallback and a 07:00 boundary wake. A true `claimed` attempt retains minute-level crash/billing reconciliation.
- Preserve immediate post-commit enqueue wakes, signed receipt wakes, startup reconciliation, pre-send rechecks, approval, customer opt-out, booking, staff takeover, expiry, Meta receipt ambiguity, and billing protections.
- A failed deadline read or invalid result retries in one minute; it must never silently treat an unreadable queue as empty.
- No changes to marketing eligibility, follow-up timing, user messages, or customer records.

## Marketing SQL benchmark and decision: reject proposed change
- An earlier version of this PR pre-filtered the materialized marketing follow-up seed by sender. This edit and its test were reverted after the same isolated staging snapshot showed **no reliable candidate performance gain**.
- Repeated warmed candidate runs: original 59–65 ms vs proposed 54–59 ms, with the proposed plan reading significantly more shared buffers (~42k vs ~26k). One proposed cold run measured ~133 ms.
- Next-due plans were mixed: original ~59–70 ms vs proposed ~53–54 ms, but the modified query again touched considerably more buffers.
- These runs returned no due candidate contacts in the tested window, so they do not establish true production throughput or eligibility equivalence under load.
- Do not ship the unproven sender-shortlist change. Keep the existing SQL and migration 132 contact index. Revisit only with realistic staging fixtures and demonstrated parity and benefits.

## Release verification
1. Run CI, including backend PostgreSQL and secondary media tests, and new fake-clock tests for quiet hours, immediate wakes, claimed jobs, corrupt deadline results and sender scope.
2. If tests pass, intentionally merge and deploy once with Render auto-deploy still disabled.
3. Verify production logs for errors and per-source pool acquisitions. Confirm both WhatsApp numbers, first AI replies, media results and price images, queued jobs, follow-ups, staff takeover, appointments and signed Meta receipts using non-sending/read-only evidence.
4. Compare equivalent 24-hour Neon CU-hour and message-volume windows; do not claim realized savings from staging execution times or acquisition counts alone.

## Rollback
Revert this media worker scheduling change if any confirmed media recovery delay, safety-policy or billing regression appears. The previous hourly empty fallback and one-minute active recovery are available in the prior release. Keep all Meta and follow-up authorization safeguards intact.
