# Neutro final database copy and cutover

Scope: source steep-forest-44509907/main/neondb to existing destination delicate-credit-82369573/main/neondb. Never create another project, delete the source or release unknown billing holds.

## Independent copy rehearsal

The protected workflow creates neutro_rehearsal_20261117 in the existing destination, copies a consistent PostgreSQL snapshot with PG18 pg_dump/pg_restore, compares all application records/schema/sequences, persists and rehashes a recoverable archive in neutro_backup_20261116, and verifies original production readiness. No production pause, Render write, customer test message or app deployment. Existing copies remain intact. An existing rehearsal database causes refusal, never overwrite.

The independent rehearsal permits up to 10 minutes for the copy; the production copy has a 5-minute limit. It reports only approved phase names. Table fingerprints are fetched in one request to avoid hundreds of cross-region round trips. A timeout is a failed verification, never evidence of success.

## Final operation, approval required

The owner must explicitly approve the production pause, final full synchronization, single DATABASE_URL update, and two exact-commit Render deployments. The existing dedicated Render key additionally needs environment-variable write access for this operation. Do not change its scope before approval. Keep automatic deployments off and exclude concurrent operators/deployments throughout.

1. Pin the actual source deployment, exact app commit ac3f8b281b9f3643504c9a9214af931f7a080a35, one instance, npm start. Verify both sender registrations, migration digest, original backup hashes and normal public readiness. Install PG18 clients and run all guard tests before loading credentials.
2. Retain the stale destination neondb by renaming it to neutro_initial_<UTC timestamp>. Create an empty neondb in the same project with matching locale/owner. Refuse if storage budget or identity checks fail. No source change occurs here.
3. Dispatch the approved final workflow with the observed source deploy ID and exact phrase neutro-final-copy-verify-and-cutover. Wait for final_armed. Only then send SIGUSR2 to the observed application PID through the existing Render shell. Never use /proc/PID/environ. No signal within 120 seconds expires without a production change.
4. Require three clean drain observations. A draining/unknown process must never be forcibly retired. Switch to the reviewed standalone holding command and deploy only the pinned app commit. Verify the old deployment is deactivated, holding readiness is exact, and no source database clients or active send/worker claims remain. Pending jobs and historical unknown billing states are preserved.
5. Create a fresh full archive and restore empty destination. Verify all 115 application tables and full record digests, schema, migrations, indexes, constraints, triggers, functions, both senders, large objects and all sequence values/safe next IDs. Rehash durable archive bytes. Recheck both source and destination against the archived manifest and require no other clients immediately before activation.
6. Write the destination activation journal BEFORE the single-variable DATABASE_URL PUT. Once this starts, automatic source recovery is forbidden, even if a response is lost. Verify the destination host, change to npm start, deploy only the pinned commit, then verify public readiness and service identity. No second app is started on source.
7. Observe naturally arriving messages and provider receipts for each WhatsApp number and other active channels. Verify AI replies, worker claims, follow-up eligibility, opt-outs/confirmed appointments, scheduled appointments and billing states. Do not send test messages to real customers. Readiness alone does not prove end-to-end delivery. Review delayed webhook retries and unresolved sends without replaying uncertain billing attempts.

The pause is expected to be a few minutes based on the earlier 2m9s holding/recovery rehearsal, but Render deployments, provider retries and failure investigation can extend it. There is no zero-loss or zero-delay guarantee for third-party retries. Non-2xx holding responses request provider retry; do not acknowledge held Neutro callbacks as accepted. The existing shared router continues other clients and rejects mixed Neutro batches for retry.

## Failure and rollback

Before activation, a failed verified copy can restore source only after confirming source identity, no pending deployment, and a cleanly drained or standalone holding process. A timed-out copy must have every child process confirmed stopped. Unknown deployment responses and unfinished drains require manual inspection, not blind retries.

After destination activation starts, never repoint to stale source automatically. First keep destination authoritative and repair/redeploy the pinned app against it. If a move back is essential, pause and drain destination, retire its only writer, capture a new complete archive including post-cutover incoming messages, receipts, consent/configuration and billing states, restore into a new isolated source-side database, compare all records and sequences, and only then activate one dispatcher there. Never reset jobs, erase provider IDs, replay unknown sends or overwrite the original source. Reconcile uncertain provider outcomes before any resend. Retain all archives and old databases.

Do not cancel a running final workflow without inspecting its journal and current authoritative database. An external runner failure after pause may require manual recovery; concurrency protection is not a distributed lock against other operators.
