# Neutro migration recovery preparation, November 17

## Current decision

Do not cut over or start another pause yet. The initial destination copy is stale.
Yesterday's source-only rehearsal drained safely but the intended 5–10 minute
pause lasted 38 minutes 30 seconds when recovery depended on the browser session.
Normal production was restored on the original database. This change adds a
reviewable recovery primitive and manual external-runner workflow. It does not
claim to implement a complete automatic deadline controller.

Production remains on `ac3f8b281b9f3643504c9a9214af931f7a080a35`, with one instance,
`npm start`, and automatic deployments off. The migration-preparation PR has
since advanced to `3b211bfa800fd281278f051f3a666bb5989bc88d`, including an overnight
result-media fix. Do not deploy the branch head as an incidental migration step.

At November 17 07:40 UTC (16:40 Korea), read-only database checks found:

| Item | Source | Destination |
|---|---:|---:|
| Project | steep-forest-44509907 | delicate-credit-82369573 |
| Application tables | 115 | 115 |
| Contacts | 8,367 | 8,335 |
| Messages | 19,892 | 19,548 |
| Provider receipts | 5,432 | 4,852 |
| Schema migration records | 133 | 133 |

Production had zero open receipt jobs, six unknown billing attempts and four
unknown gates. Last inbound was 07:17:05 UTC; last delivered/read assistant message
was created at 07:38:20 UTC. This demonstrates recent processing, not an exhaustive
functional test of both numbers or every follow-up. No customer test was sent.

Both archived dumps remain present in `neutro_backup_20261116`:

- `initial-20261116`: 10,035,325 bytes,
  SHA256 `db24761c3947c0602b9d4dedf80b320accf7282055da4cbf5924cf02a6d33610`.
- `rehearsal-1794834186228`: 10,049,224 bytes,
  SHA256 `2fe03382e592a9f817d61a6b9717dbbff5a4fe6a5b55ef85940d73a20ca72a5e`.

These are stored metadata/length checks today; prior restore and hash verification
is documented in the main migration report. No fresh full restore was done today.
The source project's counter was 343,648 compute seconds, about 95.46 CU-hours.
This is a project counter, not separately verified organization billing.

## Prepared command and its limits

`scripts/neutroMigrationRecovery.cjs --check` performs read-only Render API checks.
It requires `RENDER_API_KEY` from a private environment. It prints no credentials.

`--recover-source` is an explicitly approved source-only recovery operation. It
validates the service, workspace, source database, one instance, automatic deploys
off, exact live holding deployment, reviewed code, and public holding response.
It repeats checks, saves `npm start`, deploys the exact reviewed commit, and polls
that deployment. It does not update any environment variable, copy a database,
release a billing hold, or send customer messages. A failed/ambiguous deploy POST
is never automatically retried. Logs record mutation boundaries and deployment ID.

Required recovery inputs:

- `NEUTRO_EXPECTED_HOLD_DEPLOY`: the exact reviewed live holding deployment ID.
- `NEUTRO_SOURCE_RECOVERY_APPROVED=source-only-before-any-destination-writes`.

Run outside the production container. It rejects `RENDER_SERVICE_ID` to avoid
terminating its own controller during replacement. A successfully live deployment
and public HTTP 200 do not certify AI or WhatsApp delivery; follow with read-only
runtime/database identity, ingress, worker and receipt checks.

**This command must never be used after destination writes or dispatch have begun.**
It checks the saved DATABASE_URL but cannot prove that no external process wrote
to the destination. An operator must establish that independently. Render's API
has no transaction covering configuration checks and deployment, so other service
mutations must be excluded during execution. The workflow's concurrency group
serializes only participating workflows, not dashboard clicks or other tools.

## Secure runner setup still needed

The connected Render tools support deployment triggers but do not expose the
start-command update or a commit-pinned trigger. They cannot supply their session
credentials to a runner. No Render API credential has been created or copied.

1. Review this draft. The manual GitHub workflow must be available on the default
   branch before GitHub's normal workflow-dispatch entry is available. Merging
   code is not an instruction to deploy the production chatbot.
2. Create a dedicated, preferably scoped Render API key in Render account settings.
   Grant only the service/configuration read, environment-variable read, service
   update and deploy permissions necessary for this service where supported.
3. Put it directly into the GitHub environment `neutro-migration-recovery` as
   `NEUTRO_RECOVERY_RENDER_API_KEY`. Never paste it into chat or commit it.
   Configure environment approval and branch restrictions before enabling runs.
4. Run the workflow's `check` operation only. Confirm the runner can inspect the
   source service without modifying it. No workflow run has been launched here.
5. Validate the API mutation payload and deploy response shape against live API
   access in a separately approved recovery rehearsal before calling recovery
   operationally proven. Local tests use mocked responses.

No new paid service is provisioned. GitHub Actions usage must fit the account's
existing allowance or receive approval before any additional paid usage.

## Still required before final cutover approval

- Complete and verify a bounded controller that starts independently **before**
  any pause. This helper is manually invoked and does not yet arm a deadline.
- That controller must own the phase transition: before destination writes it may
  return to source after cancelling copy work; after destination activation it
  must never blindly resume the stale source. Persist phase and deployment IDs.
- Confirm callback retry behavior or use durable ingress. Synthetic HTTP 503
  checks from yesterday did not prove actual provider redelivery.
- Recheck current writers, pooled idle backend ownership, code, storage and held
  billing records. Preserve unknown sends and historical receipts exactly.
- Obtain final cutover approval only after those gates pass. Then stop writers,
  take a fresh durable backup, perform and verify the final full copy, change only
  the production DATABASE_URL, and start exactly one destination-backed instance.
- Keep the original source and every backup. After any destination writes, rollback
  needs reverse synchronization or a code-only rollback retaining the new DB.

No production pause, deployment, DATABASE_URL update, plan change or customer send
was performed while preparing this change. The destination is not production-ready.

## Validation and references

19 targeted Node tests passed: wrong database/deploy/code, pending or unknown
deploy, concurrent database change, missing approval, exact mutation scope,
ambiguous POST, failed deploy, timeout, and credential-safe error handling.
JavaScript syntax and whitespace checks also pass. Live API mutation behavior
and independent recovery remain untested.

- https://api-docs.render.com/reference/update-service
- https://api-docs.render.com/reference/create-deploy
- https://api-docs.render.com/reference/retrieve-env-var
- https://render.com/docs/api
- https://render.com/docs/configure-environment-variables
