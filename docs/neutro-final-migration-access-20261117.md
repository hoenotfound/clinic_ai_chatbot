# Final migration access and checks, November 17

Production stays on source project `steep-forest-44509907`, branch
`br-sparkling-recipe-b3q8n2jb`, database `neondb`. The existing destination is
`delicate-credit-82369573`, branch `br-steep-thunder-aoz5k26e`, database `neondb`.
No additional project, paid service, production deployment or pause is required
to perform the read-only checks in this document.

## Reviewed source verification

Helper `bcc23aaa3a1e280e5447b9df2da6004f780d4a02` adds `--verify-source` to
`neutroMigrationRecovery.cjs`. It checks the exact source deployment, database,
configuration and public readiness using only GET requests. It retries public
readiness for at most 60 seconds plus in-flight request timeouts. An identity
failure stops immediately. No deployment is retried or requested. All 76 local
migration tests passed before publishing that revision.

PR #661 activates this helper in the two existing manual workflows and changes
the access check to `--verify-source`. It does not run the pause rehearsal or
deploy the application. A normal read-only result is not a new successful live
transition and must not overwrite the failed rehearsal's historical outcome.

## Destination credential approval boundary

The protected GitHub environment `neutro-migration-recovery` currently contains
only `NEUTRO_RECOVERY_RENDER_API_KEY`. It requires owner review, disables admin
bypass and allows only main. Do not weaken those controls.

Proposed new environment secret: `NEUTRO_MIGRATION_DESTINATION_URL`.
Its value must be obtained privately from the connected Neon account for the
existing destination branch and `neondb`. It gives the approved GitHub runner
database access to that destination. It must never be pasted in chat, workflow
inputs, source files, command arguments or logs. Adding it through the browser
requires specific confirmation because this grants the runner additional access.
This is separate from production cutover approval.

The source credential is already available through the existing authorized
Render environment-variable read. The checker reads only DATABASE_URL and uses
it in memory. It does not enumerate other environment variables.

After approval, store the destination credential in that existing protected
environment, activate a workflow pinned to the reviewed helper commit, and run
`node scripts/neutroMigrationDataCheck.cjs --read-only`. Install dependencies
from the existing lockfile with `npm ci --ignore-scripts --omit=dev` before
injecting credentials. The check:

- Requires the source and destination hosts and `neondb`, uses direct
  connections with verified TLS, and forces read-only sessions/transactions.
- Checks PostgreSQL 18, 115 application tables, 53 sequences, matching 133
  migration records, both exact WhatsApp registrations, foreign-key validation
  and message/contact relationships.
- Checks the actual stored bytes of both retained backup archives against their
  recorded hashes. It prints only counts, schema hashes and archive metadata.
- Rechecks the same live Render deployment and public readiness afterward.
- Reports `cutoverReady=false` and `finalCopyVerified=false` even on success.
  Separate live snapshots are not a final consistent data comparison.

85 local migration tests passed with the new checker, including wrong host,
TLS/session override rejection, missing access, damaged/missing backup,
orphan records, changed sender/deployment and connection failure. Render and
database calls are mocked in these tests. The SQL and registration/archive
queries were separately executed read-only against the actual databases.
The new runner path has not yet been executed with a destination secret.

## Final synchronization remains gated

Do not wrap a manual copy inside the source-only rehearsal controller: it
automatically restores source immediately after holding. The final controller
must instead own all copy and activation phases. It still needs completion and
review. Destination access alone does not make it ready.

Before any approved pause: verify no concurrent operators/deployments, sufficient
free storage and compute, the exact application commit, PostgreSQL 18 dump and
restore clients, and the protected runner's connectivity. Record the full
protected billing/consent/receipt state without exposing customer details.

During the separately approved final window: drain tracked work, retire the old
dispatcher, prove no remaining source writers, preserve the initial destination
by renaming it, create an empty destination neondb, dump/restore the full source,
retain and rehash the final archive, compare every table's full-row digest,
schema, sequence values and safe next IDs, and recheck source stability.
Do not force-disconnect unidentified clients or reset unknown billing holds.

Only after those comparisons pass may the approved operation change production
DATABASE_URL and start exactly one destination-backed application. Shared router
and QA database variables stay unchanged. The existing Render key has read-only
environment access; automated DATABASE_URL updates need separately approved
environment-write permission or another reviewed authorized update mechanism.
Neither access expansion is authorized by this document.

Keep the original project and archives. Before destination application writes,
cancel copy work and establish a single source dispatcher before restoring
source. After any destination writes or sends, never repoint to stale source.
Prefer a code rollback retaining destination; otherwise drain destination,
archive its new state, reverse-copy into an isolated source-side database,
verify all records/receipts/holds, then resume exactly one dispatcher.

Incoming callbacks during holding rely on provider retry. One prior delayed
secondary message was proven redelivered, but complete retry coverage for both
numbers and all channels has not been established. A safe final controller and
bounded retry/reconciliation procedure remain required. No test messages may be
sent to real customers to close this gap.
