# Client provisioning and readiness

This repo includes an internal operator workflow for the production deployment model:

```text
one client
  -> one Render web service
  -> one Neon project/database
  -> one explicit chatbot industry profile
  -> one explicit purchased-channel contract
  -> production readiness verification
```

Provisioning is conservative: it is a dry run unless `--execute` is supplied. Readiness verification never sends a synthetic customer message, deletes infrastructure, or edits client business/Pipeline data.

## What provisioning automates

For a new client, `provision-client`:

1. requires an explicit business industry;
2. requires the messaging channels the client actually bought;
3. validates Render/Neon options and required client runtime credentials before cloud creation;
4. checks Render and Neon for exact resource-name collisions;
5. creates Neon in the selected region and waits for create operations;
6. retrieves the pooled PostgreSQL connection URI;
7. creates the Render Node web service with `DATABASE_URL`, a generated `SESSION_SECRET`, and canonical `INITIAL_BUSINESS_TYPE`;
8. waits for the initial Render deployment to become `live`;
9. records the deployed Git commit when available;
10. proves the bootstrap administrator can log in;
11. sets provisioner-owned `PUBLIC_BASE_URL` to the actual Render URL;
12. removes `ADMIN_PASSWORD` from Render after bootstrap succeeds;
13. deploys the finalized runtime and waits for it to become `live`;
14. runs authenticated readiness verification;
15. writes a secret-free v3 provisioning/readiness receipt.

The final verification reuses protected Setup Status and `systemHealth`. It adds a stricter go-live proof without changing the ordinary Setup Status meaning of “last successful outbound.”

## Industry contract

Supported canonical profiles:

- `aesthetic_clinic`
- `home_renovation`
- `generic`

Aliases accepted by the production resolver, such as `renovation`, `carpentry`, and `cabinetry`, normalize before cloud operations.

The provisioner injects:

```text
INITIAL_BUSINESS_TYPE=<canonical profile>
```

before first startup so the deployment seeds and locks the intended profile immediately.

## Purchased messaging channels

Provisioning requires an explicit purchased-channel contract:

```text
--channels whatsapp
--channels whatsapp,instagram
--channels facebook,instagram
```

Supported canonical values:

- `whatsapp`
- `facebook` (Messenger)
- `instagram`

Aliases include `wa`, `fb`, `messenger`, and `ig`.

Only purchased channels block go-live. An unpurchased channel may remain unconfigured.

### Exact go-live round-trip evidence

A purchased channel becomes round-trip ready only after:

1. a real customer inbound message is stored;
2. the normal AI reply path produces an outbound message for the **same contact after that inbound**;
3. that exact saved AI message has provider-acceptance evidence:
   - WhatsApp: its WAMID;
   - Messenger/Instagram: the exact `externalMessageId` returned by Meta;
4. no newer failed normal-AI reply attempt exists for that conversation;
5. normal runtime messaging health is healthy.

This proof is stored in `outbound_message_evidence`, keyed by the exact saved message ID. It is telemetry only and does not control delivery.

The following **cannot** satisfy go-live proof:

- staff/manual replies;
- scheduled messages;
- automated follow-ups;
- promotion messages/images;
- unsupported-media/transcription/processing system fallbacks;
- an unrelated successful Facebook/Instagram send to another contact.

This strict readiness evidence is intentionally separate from ordinary Setup Status operational health. Setup Status continues to use its broader existing “last successful outbound” metric so a real staff/manual recovery send can still clear an operational delivery warning.

Readiness telemetry is recorded best-effort after provider delivery and is not awaited by the customer reply path. If telemetry cannot be written, customer delivery remains unchanged and readiness fails closed until valid evidence exists.

A new deployment can legitimately finish as:

```text
Infrastructure: LIVE
Client readiness: NEEDS ATTENTION
```

until each purchased channel has a real test conversation.

## Control-plane credentials

Keep these only in the local operator shell/environment:

```bash
export PROVISIONING_RENDER_API_KEY="..."
export PROVISIONING_RENDER_OWNER_ID="..."
export PROVISIONING_NEON_API_KEY="..."
# Optional for organization-scoped Neon provisioning.
export PROVISIONING_NEON_ORG_ID="..."
export PROVISIONING_RENDER_PLAN="starter"
```

Optional defaults:

```bash
export PROVISIONING_RENDER_REGION="singapore"
export PROVISIONING_NEON_REGION="aws-ap-southeast-1"
export PROVISIONING_RENDER_REPO="https://github.com/hoenotfound/clinic_ai_chatbot"
export PROVISIONING_RENDER_BRANCH="main"
export PROVISIONING_RESOURCE_PREFIX="da-chatbot"
```

Provider/CLI errors redact runtime secrets, control-plane tokens, bearer credentials, and PostgreSQL URLs.

## Client runtime configuration

Client application variables come from a local dotenv file, for example:

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...

ADMIN_USERNAME=admin
ADMIN_PASSWORD=...

WHATSAPP_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
```

For `--execute`, provisioning fails **before creating Neon or Render** when required readiness credentials are incomplete. Preflight requires:

- `ADMIN_USERNAME` and `ADMIN_PASSWORD`;
- at least one AI credential path (Gemini or Claude);
- required R2 credentials;
- credentials for every purchased channel.

`ADMIN_PASSWORD` exists in Render only for bootstrap. After the first successful administrator login, it is removed and the finalized runtime is deployed. Keep the local runtime file secure because `verify-client` still needs the administrator password; the user account itself is persisted in PostgreSQL.

Passwords are not accepted as CLI flags.

Provisioning owns and rejects these client-input keys:

- `DATABASE_URL`
- `SESSION_SECRET`
- `INITIAL_BUSINESS_TYPE`
- `BUSINESS_TYPE`
- `PUBLIC_BASE_URL`
- `PORT`

Every `PROVISIONING_*` key is also rejected from the client runtime file.

## 1. Review the dry-run plan

Example:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env
```

No Render, Neon, or client-portal request is made in dry-run mode. Output contains runtime key names only, never secret values.

## 2. Execute provisioning

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env \
  --execute
```

Add `--json` for automation.

### Exit codes

```text
0 = dry run, READY, or READY WITH WARNINGS
2 = validation/provisioning failure before a usable deployment exists
3 = infrastructure live; verification completed; NEEDS ATTENTION
4 = infrastructure live; readiness verification could not complete
```

Do not delete/recreate infrastructure merely because readiness returns 3 or 4.

## Readiness states

### READY

Every required profile, Setup Status, operational-health, and purchased-channel exact round-trip check passed without warnings.

### READY WITH WARNINGS

No blocker exists, but a non-fatal warning remains, such as degraded-but-usable AI health.

### NEEDS ATTENTION

Verification completed and trustworthy evidence shows at least one required condition is incomplete/unhealthy.

Missing required Setup Status results fail closed and remain `missing` blockers.

### VERIFICATION FAILED

A trustworthy verification could not complete, for example because login, transport, or protected Setup Status execution failed.

## What READY evaluates

### Business profile

- actual business type matches requested industry;
- selection is locked;
- Pipeline profile aligned;
- conversion profile aligned;
- lead-temperature profile aligned;
- Analytics profile aligned without fallback.

### Core Setup Status

Every required core result must be returned, configured, and `ready`:

- database;
- session security;
- actual public URL;
- administrator account;
- AI reply engine;
- R2/media storage.

Additional returned non-optional, non-channel checks are also required.

### Operational system health

`systemHealth` must show:

- database/runtime healthy;
- migrations `up_to_date`;
- inbound processing healthy;
- AI runtime available.

AI runtime `error` blocks go-live. Degraded-but-usable AI yields READY WITH WARNINGS when nothing else blocks.

### Purchased channels

Each purchased channel requires both its Setup Status checks and exact per-message AI evidence.

```text
--channels whatsapp
  -> whatsapp
  -> whatsapp_webhook
  -> latest real WhatsApp inbound
  -> exact later AI reply message with WAMID
  -> no newer failed AI reply attempt
  -> healthy ordinary WhatsApp runtime

--channels instagram
  -> instagram
  -> meta_webhook
  -> latest real Instagram inbound
  -> exact later AI reply message with Meta externalMessageId
  -> no newer failed AI reply attempt
  -> healthy ordinary Instagram runtime

--channels facebook,instagram
  -> each channel proves its own exact round trip
  -> shared meta_webhook must also be ready
```

## 3. Complete real channel tests

For every purchased channel, send a genuine customer test message and confirm the chatbot’s **normal AI reply** arrives. A webhook, staff reply, scheduled message, follow-up, fallback, or unrelated channel send is not sufficient.

Because readiness evidence is telemetry-only and best-effort, if the reply arrived but a transient telemetry write failed, fix the database/runtime issue and run another clean test conversation rather than treating the original delivery as failed.

## 4. Re-run readiness without reprovisioning

Preferred:

```bash
npm run verify-client -- \
  --receipt .provisioning/acme-cabinets.json \
  --runtime-env-file ./acme.client-runtime.env
```

Without a receipt:

```bash
npm run verify-client -- \
  --url https://da-chatbot-acme-cabinets.onrender.com \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

`verify-client` does not create/delete cloud resources and does not modify chatbot settings, Pipeline data, or messaging data. With `--receipt`, it atomically updates only the secret-free readiness receipt and `lastVerifiedAt`.

Verifier exit codes:

```text
0 = READY / READY WITH WARNINGS
2 = invalid verifier input
3 = verification completed but NEEDS ATTENTION
4 = login/transport/Setup Status verification could not complete
```

## Resource naming and duplicate protection

Default cloud resource name:

```text
da-chatbot-<normalized-client-slug>
```

Before creation, exact Render/Neon collision checks run. Neon search is paginated and fails closed on incomplete `unavailable` results.

Execution also holds a same-machine lock:

```text
.provisioning/<resource-name>.lock
```

Provider `409` conflicts remain a second protection layer for separate-machine races.

## Provisioning/readiness receipt

After infrastructure is live, the CLI writes:

```text
.provisioning/<client-slug>.json
```

Receipt v3 contains only recovery/readiness metadata, including:

- `completedAt` and `lastVerifiedAt`;
- client/industry/channel contract;
- Neon identifiers;
- Render service/deploy metadata;
- deployed commit SHA when available;
- runtime-finalization state;
- profile contract;
- latest readiness report.

It never contains `DATABASE_URL`, API keys, access tokens, administrator passwords, or copied runtime-env values.

Runtime finalization records:

```text
completed: true
```

when fully successful. If finalization fails after making some Render changes, the receipt preserves the known partial-finalization fields as `runtimeFinalization`, adds:

```text
completed: false
failureCode: RENDER_RUNTIME_FINALIZATION_FAILED
```

and keeps the existing infrastructure for deliberate recovery.

Receipt-write failure after infrastructure is live is a warning, not a false cloud-provisioning failure.

## Partial failures

Cloud create requests are non-idempotent and are never blindly retried. There is no destructive automatic rollback.

- Neon created / Render fails: Neon is preserved with recovery identifiers.
- Render created / deploy fails: known Render + Neon identifiers are preserved.
- Runtime finalization partially fails: the exact known finalization state is preserved in the result/receipt.
- NEEDS ATTENTION: fix the reported condition and rerun `verify-client`.
- VERIFICATION FAILED: fix access/login/transport/Setup Status and rerun `verify-client`.

See `PROVISIONING_RECOVERY.md` for detailed recovery steps.

## Render build/start/health contract

```text
Build: npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build
Start: npm start
Health check: /
```

Render `live` proves only that the web process serves. Client handover requires READY or READY WITH WARNINGS, with any warning explicitly accepted by the operator.
