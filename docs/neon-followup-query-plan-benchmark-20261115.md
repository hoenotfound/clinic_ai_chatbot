# Neutro follow-up SQL: isolated staging benchmark (2026-11-15)

## Scope
Neon project `steep-forest-44509907`; **isolated child branch**
`br-late-brook-b3sgk13l` (`bench-followup-readonly-20261115`).
Read-write compute locked to 0.25 CU and the account's normal idle timeout.
The branch was cloned from main at a point in time to reproduce the real
schema, contact counts and rule distribution. No customer records were
returned, no messages were sent, and production indexes or rules were
changed.

The exact `CANDIDATES_SQL` and `POTENTIAL_DUE_SQL` constants for ordinary
service and marketing follow-ups were exported by a **temporary, unmerged
CI-only** test and executed under `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
EXECUTE` on the isolated branch with sender-matching parameters. The
benchmark had 8,312 contacts, 12 enabled marketing rules, 3 service rules,
and 487 recent verified inbound messages. Queries returned zero due
candidates in the sampled eligibility window, so these timings are not a
complete throughput benchmark during active customer follow-ups.

## Before and after the cross-sender contact index

Execution time, rounded to the nearest ms; the numbers are **not** billed
CU-hour savings.

| Full query | Existing indexes | New contacts index |
| --- | ---: | ---: |
| Secondary service candidates | 2,211–2,270 ms | 85–115 ms |
| Secondary service next-due | 673 ms | 19 ms |
| Secondary marketing next-due | 730 ms | 50 ms |
| Secondary marketing candidates | 620 ms | 895–936 ms |

The contact lookup index is a 352 kB partial index on the staging snapshot
and was used by the planner in many repeated historical cross-number
lookups. These previously performed correlated full-table `contacts`
scans: up to 123 loops visiting roughly 8,100 rows each in the service
candidate plan, contributing roughly 1,050 ms self-time. Repeated full
scans of sender conversations and message context also disappeared or
became less important after this plan improvement.

**Important trade-off:** the marketing candidate search was slower after
the index and still used repeated materialization (about 48,000 loops),
so this migration is not a complete fix for marketing follow-up SQL. The
new index also imposes a small maintenance cost on contact writes.

### Rejected alternative
A separate **staging-only** recent-inbound message partial index reduced
a recent-message shortlist query from roughly 0.93–1.02 ms to
0.62–1.00 ms after warming. This small change does not justify a
production migration, and is **not** included in this PR.

Turning off nested-loop joins for the full marketing candidate query in
staging made the query slower (approximately 2.65 s). Do not globally
disable nested-loop planning.

## Proposed migration
`132_contacts_whatsapp_number_cross_sender.sql` only creates:

```sql
CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_number_cross_sender
 ON contacts (whatsapp_number, id)
 INCLUDE (whatsapp_sender_id)
 WHERE channel = 'whatsapp';
```

This does not change query text, patient contact data, consent, staff
ownership, appointment state, scheduling, delivery/billing reservations or
provider messages.

**Deployment caution:** the existing migration runner wraps schema changes
in a transaction, so `CREATE INDEX CONCURRENTLY` is not supported.
The ordinary `CREATE INDEX` can briefly block contact writes while it
builds. Though the measured table was small, deploy only after review of
the CI tests and with a rollback plan. A failed migration stops startup.
Keeping the index after rollback is safe, but removing it would require a
separately reviewed DDL operation.

## Verification
- CI migration history and isolated PostgreSQL schema tests must pass.
- Cross-sender lookup results must match before and after index creation.
- Recheck both WhatsApp numbers, ordinary and consented marketing
  follow-up windows, recipient eligibility, booking and staff exceptions,
  and billing protections after deployment if one is later approved.
- Use passive `[Neon pool activity]` and `pg_stat_statements` in
  comparable traffic windows. Do not claim savings from staged durations
  alone.
- Investigate the remaining marketing-candidate CTE join/materialization
  separately, preserving exact eligible-contact equivalence.

The staging branch contains a point-in-time production snapshot: restrict
access, keep it out of any public workflow, and suspend its compute when
benchmarks finish. Its lifecycle and eventual deletion require explicit
review.
