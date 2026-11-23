# Neutro Sense: avoid redundant secondary follow-up candidate scans (2026-11-22)

## Why this is needed

Production Neon Free project `delicate-credit-82369573` recorded frequent
compute starts and repeated, expensive full follow-up queries in
`pg_stat_statements` over a short observation window. The ordinary secondary
marketing candidate selector averaged ~2.08 seconds per call; its next-due
hint averaged ~1.77 seconds. The service selector also appeared in costly query
samples. These are statement execution times, **not** directly billed CU-hours.

## Change

The secondary service and marketing schedulers already calculate a read-only
potential-due hint using the same sender, consent, appointment, opt-out,
coexistence, attempt and billing rules as the full candidate selector.

On every scheduled or event-triggered wake, first query the *fresh* potential-due
hint. Skip the full candidate scan only if the hint definitively says
`has_overdue === false` and its earliest next due is either absent or in the
future. Uncertain, null, invalid, incomplete or overdue hints always run the original
candidate selector. If a due-time hint remains unavailable after that full
scan, schedule another check in five minutes instead of the one-hour idle
backstop. A valid empty hint retains the normal hourly idle interval. The clock is reread **after** the hint SQL, so a due slot
cannot be skipped merely because the hint took time to execute. When candidates
might be due, run the existing selector and all exact pre-send safeguards,
then refresh the next-due hint as before. Full 10-attempt batches continue
using the existing 10-second backlog drain.

No output wording, appointment rule, send timing, opt-in evidence, billing
reservation, provider retry, media choice or eligibility predicate changes.
No cached database state, persistent timers or new schema objects.

## Safety / rollout

- Run `node --test test/secondaryDueTimeScheduler.test.js`.
- Run the complete backend and PostgreSQL integration suites in CI, especially
  sender isolation, follow-up eligibility, billing receipts, 131060 recovery,
  opt-outs, booked contacts, quiet hours and Day4/Day6.
- Compare event- and real-time clock behavior for follow-up selection when
  several customer messages, delivery receipts or booking events arrive.
- Deploy **manually** only after reviewing passing CI and the PR. In production,
  watch the existing 5-minute `[Neon pool activity]` and
  `[Refresh/wake diagnostics]` summaries plus Neon compute starts/suspensions.
- Check real secondary follow-up timeliness, missed sends, approved billing
  status, the primary number, AI media and manual staff suppression.
- Compare at least two representative 24-hour usage windows with similar
  traffic. Lower SQL calls alone do not prove fewer billed CU-hours.
- Roll back the PR commit if any potential-due hint fails to cover an actual
  sendable slot. The older full-scan-first behavior remains the fallback when
  `preflightDueHint` is omitted.

Neon autosuspend, the cross-sender contacts index, and all sender/billing
configurations remain unchanged.


## Phase 2: batch marketing due hints and skip provably blocked night scans (2026-11-23)

### Why
- The 2026-11-22 deploy reduced full selector scans, but Neon usage remained
  around 7 CU-hours/day. Compute active time remained approximately 80%, with
  frequent wake-ups and a 07:00 MYT secondary-worker spike.
- Marketing's ordinary, extended Day4/Day6 and consented general follow-up
  hints previously made up to **three separate DB reads per scheduler wake**.
  Every due hint still retained all original sender/consent/booking/Meta gates.

### Changes
- Combine enabled marketing due hints with `UNION ALL` in **one read-only
  PostgreSQL statement**. Each lane still executes its original exact
  candidate-derived hint, with independently enabled gating. The outer query
  uses `MIN(next_due_at)` and `BOOL_OR(has_overdue)` for the same combined
  result. One pool checkout replaces two or three serial pool checkouts.
  This saves network round trips, **not necessarily the SQL CPU work**.
- From 00:00 through 06:59 MYT, the two secondary schedulers use a
  **clock-only 07:00 hint**. This is allowed only when every full candidate
  and pre-send recheck SQL contains the original
  `EXTRACT(HOUR ...) BETWEEN 7 AND 23` guard. No WhatsApp follow-up is
  authorized or sent at night. At 07:00, fresh SQL executes; overnight
  customer messages, delivery receipts, opt-outs, booking changes and rule
  updates are re-evaluated there. A clock-boundary race retries in one second.
- Proven social-channel `pipeline_changed` events no longer wake WhatsApp
  secondary workers. Unknown/WhatsApp events, booking, opt-out, messages,
  rules and relevant delivery receipts remain conservatively actionable.
- Passive fixed-label counters now measure: `hint_query`,
  `scan_skipped`, `scan_performed`, `quiet_hours_skipped`,
  `hint_failed`, `hint_uncertain`, `post_hint_query`,
  `due_found`, `backlog` and `receipt_coalesced` separately for each
  secondary lane. The existing five-minute diagnostic timer emits
  `[Secondary due scheduling]` without added SQL or new timers.

### Release and verification
1. Run full GitHub CI, including the real isolated PostgreSQL compilation
   tests for ordinary-only, ordinary+Day4/Day6, ordinary+general and all lanes.
2. Confirm both live worker activation flags, primary WhatsApp replies, media,
   pricing graphics, Meta 131060 recovery, Day4/Day6, billing and consent.
3. During the first subsequent midnight-to-07:00 MYT window, verify
   `quiet_hours_skipped` rises without `hint_query` for night wakes.
   At 07:00, both lanes must resume normal fresh eligibility scans and
   deliver only authorized reminders.
4. Compare like-for-like 24-hour Neon CU-hours, compute starts/suspensions,
   Render pool acquisitions and accepted follow-up events; compare quiet
   hour and business hour loads separately. **Never claim billable CU savings
   from a drop in pool acquisition counts alone.**
5. If eligibility changes, unexpected missing follow-ups, or increased SQL
   errors occur, rollback to the previous production commit. This PR has no
   schema migration, clinic-config write or customer-message send.

The scheduler remains fail-open on uncertain SQL hints, retains a five-minute
retry after hint failures, and makes no changes to actual pre-send guards,
sender identity, media, treatment pricing, opt-in or one-shot billable claims.
