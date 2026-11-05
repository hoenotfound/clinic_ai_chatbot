# Neutro Neon transfer reduction: 5 November 2026

## 2 PM baseline (MYT)
- Neon project steep-forest-44509907: 885,494,507 transfer bytes, up from 839,541,653 bytes this morning.
- `pg_stat_statements` is installed and collecting SQL statistics.
- Secondary service follow-up candidate query: 113 calls at 17.3s mean execution time.
- Secondary marketing candidate query: 193 calls at 2.13s mean execution time.
- Marketing scheduler next-due query: 193 calls at 2.23s mean execution time.
- Full Contacts directory: 49,018 rows returned across six executions.
- Inbox page-index query: 73,545 rows across 57 executions.
- SQL runtime and sequential scans are **not** equivalent to billed network bytes.

## Changes
1. **Secondary WhatsApp**: The latest main branch already includes safe recent-inbound shortlists (24h for service and 9 days for marketing, preserving Day 4/Day 6). Retain that implementation unchanged during this merge, including all booking, consent, opt-out, staff takeover, billing, one-shot and pre-send guards. PR #539 adds regression coverage but does not replace these newer queries.
2. **Contacts**: `/api/contacts/paged` returns at most 100 contacts and runs expensive message counts only on the selected page, with search, assignment filters, total count and owner options. Contacts page and Add Lead modal use paged results; full CSV exports are unchanged.
3. **Inbox**: Optional 45-second WAL-verified index cache for unscoped full-access views, enabled only by `INBOX_INDEX_WAL_CACHE_ENABLED=true`. Permissions are rechecked per request, scoped users never share the cache, and any WAL mismatch falls back to the original SQL.

## Review and rollout
- Keep Neutro auto-deploy disabled. CI must pass before a deliberate deploy.
- Compare Neon's transfer counter after deployment over a similar traffic period. SQL optimization alone does not measure billed transfer.
- Run post-deploy samples of `pg_stat_statements` for the four secondary candidate/due query IDs and Contacts paging.
- Confirm the retained 2h/6h/20h, 48h/66h and Day4/Day6 follow-ups respect verified sender, consent, booking, opt-out, human handoff, media and ambiguous-provider safeguards. Never resend a previously attempted follow-up.
- Test Contacts search, assignment filters, Add Lead, CSV exports, Inbox filters and restricted staff views.
- The optional Inbox cache can be rolled back immediately by disabling its flag, while leaving other code running.
