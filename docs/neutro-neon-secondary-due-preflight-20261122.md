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
future. Uncertain, null, invalid or overdue hints always run the original
candidate selector. The clock is reread **after** the hint SQL, so a due slot
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
