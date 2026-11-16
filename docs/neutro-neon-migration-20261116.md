# Neutro Neon migration preparation, 16 November 2026

## Status and limits

Preparation only. Do not merge, deploy, pause production or update Render
variables without explicit production approval. Automatic deployments were off
when inspected. The initial copy and a second full-copy rehearsal are verified.
The opt-in planned pause control is implemented and locally tested in this PR.
It is not deployed. Production still lacks this control, and the destination
copy is stale. A live transition and actual provider retry delivery remain
unverified. This document does not authorize the production switch.

| Resource | Value |
| --- | --- |
| Source project / branch | `steep-forest-44509907` / `br-sparkling-recipe-b3q8n2jb` |
| Destination project / branch | `delicate-credit-82369573` / `br-steep-thunder-aoz5k26e` |
| Application database | `neondb` on both projects |
| Render service | `srv-daqd1rp42hec7398itr0` |
| Reviewed production commit | `6d313523466935b82fd9601b3536fd1155f1fbce` |
| Backup database in destination | `neutro_backup_20261116` |
| Rehearsal database in destination | `neutro_rehearsal_20261116` |

No additional project, paid service or plan change was made. Source data and
backups remain intact. No customer messages were sent by this work.

## Evidence

The copy runner ran with PostgreSQL 18.7 clients in the existing Render shell.
The source transaction was read-only and its exported snapshot was shared by
`pg_dump` and row verification. The destination application was never started.

At 13:03:06 UTC, `neutro_rehearsal_20261116` matched 115 application tables,
97,016 rows, 53 sequence values and the compared schema definitions. Count and
full-row digest matched for every table. The restore built the foreign keys and
other constraints after loading records. The runner also checked that each
owned positive sequence's next value exceeds its existing maximum ID.

| Rehearsal record | Count |
| --- | ---: |
| Contacts | 8,337 |
| Messages | 19,564 |
| Sender conversations | 8,089 |
| Provider receipts | 4,879 |
| Billing attempts | 1,469 |
| Billing gates | 198 |
| Service follow-up attempts | 355 |
| Marketing follow-up attempts | 70 |
| Consent events | 285 |
| Migration records | 133 |

Copy and verification took 10.128 seconds. This excludes deployment, shutdown,
final incident review and restart, so it is **not a downtime estimate**.

The recovered binary dump was stored and read back with a matching SHA-256 in
`neutro_backup_20261116.migration_archive.production_dump`:

- Row: `rehearsal-1794834186228`
- Bytes: `10049224`
- SHA-256: `2fe03382e592a9f817d61a6b9717dbbff5a4fe6a5b55ef85940d73a20ca72a5e`
- The earlier archive `initial-20261116` and restored backup remain present.
- The archive includes the row/schema manifests and captured sequence values.

The comparison accepts only the reviewed Neon-managed `cloud_admin` ACL
differences and equivalent casts on the named
`ai_usage_events_response_disposition_check` constraint. Every other application
grant and constraint definition must match. The full unmodified dump is kept.

## Callback routes and shared-service dependency

Read-only Meta subscription queries confirmed these callbacks:

| Channel | Callback |
| --- | --- |
| Primary WhatsApp | `https://neutrosense.dasmarketingsolution.com/webhook` |
| Secondary WhatsApp through app default | `https://neutrosense.dasmarketingsolution.com/whatsapp/default` |
| Facebook / Instagram app subscriptions | `https://da-chatbot-neutro-sense-tcm.onrender.com/meta-router/meta-webhook` |

The shared router also forwards Facebook and Instagram events for `bb-demo`
and `da-chatbot-sales`. Blanket service suspension would affect those clients.
The standalone hold server therefore loads only the existing shared router and
its separate database connection. It forwards other-client-only batches as
normal. Neutro callbacks, staff application routes and mixed batches containing
Neutro receive HTTP 503. A mixed batch is refused before forwarding any part.

The tests use synthetic signed payloads and fake forwarders. They prove local
response behavior, not live provider retry delivery. Provider retries are not
a durable queue operated by this application. An independent durable holding
queue or a bounded, verified retry procedure is still needed before promising
no lost callbacks during a pause.

Keep `META_ROUTER_DATABASE_URL` and `WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL`
unchanged. Router records contain target URLs and asset mappings, not customer
database credentials. Operations metadata is not the chatbot database runtime
connection. The other inspected Render services use different database hosts.
Dormant external scripts cannot be ruled out by a single activity snapshot.

## Prepared commands

These commands are not an instruction to run production maintenance now.
Supply credentials privately through environment variables, never arguments or
logs. Do not disable TLS certificate validation.

`node scripts/neutroMigrationHold.cjs` starts only when explicitly configured
with `NEUTRO_MIGRATION_HOLD=20261116`, the reviewed client/database/router
identities, signing configuration and no Node preloads. Do not run it through
`npm start`. It needs the existing router configuration and `PORT`. Its GET `/`
health check reports `migration_hold`, not chatbot readiness.

`node scripts/neutroMigrationBoundary.cjs` reads source job, attempt and gate
state plus other database connections. It always reports
`cutoverAuthorized: false` and `processRetirementVerified: false`. It never
resets a claim or releases a billing hold. Compare individual protected states
privately at the boundary; aggregate counts alone can conceal changed records.

`node scripts/neutroMigrationCopy.cjs neutro_rehearsal_YYYYMMDD` copies only into
an already-created empty database on the pinned destination host. It will
refuse the now-populated rehearsal database. It never drops or cleans objects.

Final target `neondb` additionally requires both
`NEUTRO_FINAL_COPY_APPROVED=20261116` and
`NEUTRO_OLD_INSTANCE_RETIRED=confirmed`. These are operator attestations, not
automatic proof or a replacement for approval. The command checks that no
other source client is connected, then verifies source contents again after
the restore. Prevent reconnecting writers throughout the maintenance window.
The script never changes Render or starts the application.

## Planned pause control and remaining release gates

`NEUTRO_MIGRATION_CONTROL=20261116` enables the reviewed Neutro-only control.
It defaults off, validates client identity, source/destination database host and
name, and refuses one-off recovery send/reencode jobs or PR395 staging mode.
There is no public control endpoint. From the trusted Render shell, inspect
`/tmp/neutro-migration-drain-status.json`, verify its PID belongs to the current
application process, then send SIGUSR2 to that exact PID. Never signal a PID
from an older deployment. The initial file must report enabled and running.

The signal makes Neutro ingress return 503, stops new timer work and waits for
tracked HTTP handlers, queued replies, detached receipt/recovery continuations,
provider sends and subsequent outcome writes. This includes handlers that have
already acknowledged HTTP or whose client disconnected. SSE streams close.
The application pool closes only after tracked work completes. Other-client
shared-router traffic uses its separate pool and stays available. Mixed
batches containing Neutro fail before any forwarding. GET / remains healthy
and explicitly reports draining or holding; this is not chatbot readiness.

The private status file contains no credentials or customer identifiers. Require
fresh consecutive heartbeats (under five seconds old), the current PID, phase
held, active=0, faults=0 and safeToRetire=true before retirement. The process
remains alive. This status is local evidence only: separately check source
connections, protected attempts and Render instance retirement. A late denied
database operation changes safeToRetire to false. Never override a failure or
set readiness by hand. There is no automatic timeout, resume or send replay.
This is a planned SIGUSR2 pause, not a generic SIGTERM shutdown handler.

The first deployment of this code cannot retroactively drain the currently
running old code. It needs a separately approved, monitored preparatory rollout
against the existing source, with a quiet-job check and inspection of any
interrupted or uncertain sends. Do not combine that rollout with DATABASE_URL
changes. A failed rollout must leave the original source authoritative.

Before final cutover approval:

1. Require passing CI, including the real PostgreSQL drain test. Review and
   approve the preparatory rollout separately; check the running code identity
   and private status before attempting any pause.
2. Verify a holding process with a usable migration shell and actual Render
   retirement evidence. Synthetic local HTTP/process tests do not prove Render
   process replacement or Meta redelivery. Establish the verified callback
   retry procedure or an independent durable ingress path before the pause.
3. Define the operational maintenance budget after measuring deploy duration.
   If drain stalls or fails, stop the procedure, keep the original source and
   inspect active tasks/receipts. Never force-close active sends or clear unknown
   holds to meet a deadline. Resume only through one reviewed source-backed
   process after proving the old dispatcher is retired and reconciling any new
   uncertain sends. Escalate rather than silently extending the pause.
4. Recheck source consumers, deployed commit, free storage and protected send
   records immediately before the approved window. Quiet SQL alone cannot
   establish that no external send is active or that no writer will reconnect.

## Conditional production procedure after those checks and owner approval

1. Freeze staff writes and deployments. Route Neutro ingress to the proven
   holding/retry path while maintaining other clients' forwarding.
2. Stop claims and drain all active application work. Record protected send
   state and verify old process retirement independently through Render.
   Abort on an unsettled send or unknown writer. Do not infer retirement from
   an empty `pg_stat_activity` result or health check.
3. Keep a worker-free holding process alive for the migration shell. Take a
   fresh source dump and verify it. Preserve both previous copies and archives.
4. Preserve destination `neondb` by renaming it to a uniquely dated initial-copy
   database, then create a fresh empty `neondb` with the same owner/settings.
   This is a destination-only operation. Do not drop the previous copy or run
   the app to recreate schema. Confirm sufficient free-plan storage first.
5. Run the final copy and full verification. Validate sender IDs
   `1408739622311791` and `1318355951360575`, all migration records, appointments,
   consent, receipts, protected holds, pending work and sequence state. Keep
   the final dump in the existing backup database and verify its checksum.
6. Update only production `DATABASE_URL` to the destination's pooled `neondb`
   connection and restore the reviewed normal start command. Start one normal
   process only after every old chatbot process is gone. A hold process may
   overlap because it has no customer dispatch workers. Do not change plans,
   consent rules, billing safeguards or business logic.
7. Check actual connected database identity, normal health, schema version and
   single worker ownership. Observe real inbound traffic, AI handling and
   signed receipts on both numbers. No customer test sends. Check expired
   follow-ups are skipped under existing rules and reservations are preserved.
8. Monitor errors, pending queue age, missing/duplicate provider IDs and changes
   in unknown send state. Record the first destination write and send. If no
   natural traffic occurs on a number, report that validation as pending.

## Rollback

Before any destination write or send, the unchanged source can be resumed only
after confirming that no destination dispatcher ran and all hold/drain checks
permit resuming. Restore the original start command and source connection at
the pinned original code version, with exactly one active chatbot process.

After destination writes or sends, do not simply restore the old URL. Keep
the destination as the authoritative record of those enquiries and receipts.
A compatible code rollback retaining the new database may be safer. If the
database must move back, hold ingress and drain again, back up both databases,
then perform a verified reverse copy into a new rollback database. Reconcile
provider receipts and uncertain sends before any worker resumes. Never replay
completed follow-ups or release historical billing holds. Keep the original
project and all existing backups throughout.

## Validation and observed production state

The final local full suite passed 4,283 tests with zero failures; 169 tests were
skipped because their database or external test prerequisites were unavailable.
A separate PostgreSQL-backed drain test is included for CI. Targeted coverage
includes a real child process receiving SIGUSR2, a pending synthetic receipt,
HTTP 503 during drain, database closure before ready, client disconnect, late
secondary commits after HTTP timeout, and a signed mixed-client router batch.
All dispatch in these tests is synthetic; no customer messages are sent.

Earlier copy/holding tests and the live copy rehearsal remain valid. At 13:51:11
UTC, read-only source inspection found no open inbound/receipt jobs, scheduled
messages, AI generation claims or pricing preflight retries. Six application
connections were idle. Historical unknowns included two gates, four billing
attempts, 12 service-follow-up attempts and two marketing-follow-up attempts.
None was reset or replayed. This is an earlier sample, not a current boundary.

Render was rechecked during this implementation and still runs commit
6d313523466935b82fd9601b3536fd1155f1fbce, deployment
dep-dbtdo9mtlv9c73f2iuhg. No production rollout, pause, URL change, live callback
retry test, end-to-end AI check or post-cutover monitoring occurred.

Vendor references:

- https://render.com/docs/maintenance-mode
- https://render.com/docs/deploys
- https://developers.facebook.com/docs/graph-api/webhooks/getting-started/
