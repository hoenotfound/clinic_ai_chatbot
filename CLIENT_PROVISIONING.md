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

The workflow is conservative. Provisioning is a dry run unless `--execute` is supplied. Readiness verification does not delete infrastructure, edit client business settings/Pipeline data, or send customer-facing test messages.

## What provisioning automates

For a new client, `provision-client`:

1. requires an explicit business industry;
2. requires the messaging channels the client actually bought;
3. validates Render/Neon choices and the required client runtime contract before cloud creation;
4. checks Render and Neon for exact resource-name collisions;
5. creates a Neon project in the selected region;
6. waits for Neon's create operations to finish;
7. retrieves a **pooled** Neon PostgreSQL connection URI;
8. creates the Render Node web service from this repository;
9. injects `DATABASE_URL`, a Render-generated `SESSION_SECRET`, and the canonical `INITIAL_BUSINESS_TYPE`;
10. waits for the initial Render deploy to reach `live`;
11. records the deployed Git commit when Render exposes it;
12. verifies the bootstrap administrator can sign in;
13. sets `PUBLIC_BASE_URL` to the actual Render service URL;
14. removes `ADMIN_PASSWORD` from Render after the successful bootstrap login;
15. deploys that finalized runtime and waits for it to become `live`;
16. runs the authenticated production-readiness verification;
17. writes a local secret-free v3 provisioning/readiness receipt.

The final readiness pass uses the application’s protected Setup Status endpoint plus the operational `systemHealth` evidence returned by that endpoint. There is no second customer-facing health-check implementation and no automated test message is sent.

## Industry contract

Supported canonical profiles are:

- `aesthetic_clinic`
- `home_renovation`
- `generic`

Aliases accepted by the production resolver, such as `renovation`, `carpentry`, and `cabinetry`, are normalized before cloud operations.

The provisioner injects:

```text
INITIAL_BUSINESS_TYPE=<canonical profile>
```

before first startup, so the deployment seeds and locks the intended profile immediately.

## Required messaging channels

Provisioning requires an explicit purchased-channel contract:

```text
--channels whatsapp
--channels whatsapp,instagram
--channels facebook,instagram
```

Supported canonical values are:

- `whatsapp`
- `facebook` (Facebook Messenger)
- `instagram`

Accepted aliases include `wa`, `fb`, `messenger`, and `ig`.

Only channels listed in `--channels` are mandatory for go-live. An unpurchased channel can remain unconfigured without blocking readiness.

A purchased channel must prove a real application round trip. READY requires:

- its required Setup Status connection/webhook checks are configured and `ready`;
- a real customer inbound message has been observed;
- a successful outbound reply has been observed **after** that inbound message;
- there is no unresolved delivery failure newer than the last successful outbound reply;
- runtime messaging health is healthy.

The verifier does not manufacture this evidence. After provisioning, send a genuine WhatsApp/Messenger/Instagram test message through each purchased channel and confirm the chatbot replies.

A newly created deployment can therefore legitimately finish with:

```text
Infrastructure: LIVE
Client readiness: NEEDS ATTENTION
```

until real channel evidence exists. Infrastructure is not rolled back.

## Control-plane credentials

Keep these only in your local shell or secure operator environment:

```bash
export PROVISIONING_RENDER_API_KEY="..."
export PROVISIONING_RENDER_OWNER_ID="..."
export PROVISIONING_NEON_API_KEY="..."
# Optional for organization-scoped Neon provisioning.
export PROVISIONING_NEON_ORG_ID="..."
```

Choose the Render plan explicitly:

```bash
export PROVISIONING_RENDER_PLAN="starter"
```

Optional operator defaults:

```bash
export PROVISIONING_RENDER_REGION="singapore"
export PROVISIONING_NEON_REGION="aws-ap-southeast-1"
export PROVISIONING_RENDER_REPO="https://github.com/hoenotfound/clinic_ai_chatbot"
export PROVISIONING_RENDER_BRANCH="main"
export PROVISIONING_RESOURCE_PREFIX="da-chatbot"
```

Render plan/region values are validated before Neon is created so simple input mistakes do not create a partial installation first.

## Client runtime configuration

Client-specific application variables come from a local dotenv file, for example:

```bash
# acme.client-runtime.env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...

# Required for bootstrap + later local readiness verification.
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

For `--execute`, provisioning fails **before creating Neon or Render** if the required readiness contract is incomplete. The preflight requires:

- `ADMIN_USERNAME` and `ADMIN_PASSWORD`;
- at least one configured AI credential path (Gemini or Claude fallback credential);
- the required R2 storage credentials;
- the credentials required by every purchased channel.

`ADMIN_PASSWORD` is copied to Render only for bootstrap. After the first successful administrator login, the provisioner removes `ADMIN_PASSWORD` from Render and deploys the finalized runtime. The local runtime file should remain securely stored because `verify-client` still needs that password to authenticate; the administrator password itself is already persisted by the application in PostgreSQL.

Passwords are intentionally **not** accepted as CLI flags so they do not enter normal shell history.

The following keys are owned by provisioning and are rejected from client runtime input:

- `DATABASE_URL`
- `SESSION_SECRET`
- `INITIAL_BUSINESS_TYPE`
- `BUSINESS_TYPE`
- `PUBLIC_BASE_URL`
- `PORT`

`PUBLIC_BASE_URL` is deliberately provisioner-owned so the final application check cannot be made green with an arbitrary runtime-file value. The provisioner writes the actual Render service URL only after the service exists.

Every key beginning with `PROVISIONING_` is also rejected from the client runtime file.

Provider/CLI errors are redacted against client runtime secrets, control-plane tokens, bearer credentials, and PostgreSQL connection URIs.

Local runtime files and `.provisioning/` state are gitignored, but should still be treated as sensitive operator material.

## 1. Review the dry-run plan

Example for a renovation client using WhatsApp + Instagram:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env
```

No Render, Neon, or client-portal request is made in dry-run mode.

Example output includes:

```text
Client:         acme-cabinets
Industry:       home_renovation
Channels:       whatsapp, instagram
Neon project:   da-chatbot-acme-cabinets (aws-ap-southeast-1)
Render service: da-chatbot-acme-cabinets (singapore)
Render plan:    starter
Health check:   /
Profile env:    INITIAL_BUSINESS_TYPE=home_renovation
```

Only runtime **key names** are shown. Secret values are never included in the plan.

## 2. Execute provisioning + verification

Run the same command with `--execute`:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env \
  --execute
```

For automation, add `--json`.

### Exit codes

```text
0 = dry run, READY, or READY WITH WARNINGS
2 = validation/provisioning failure before a usable deployment exists
3 = infrastructure is live; verification completed; NEEDS ATTENTION
4 = infrastructure is live; readiness verification could not complete
```

Exit codes `3` and `4` are deliberately different from provisioning failure. Do not delete/recreate a deployment merely because a channel still needs a real test conversation or because a transient verifier/login/transport problem prevented verification.

## Readiness states

### READY

All required business-profile, Setup Status, operational-health, and purchased-channel round-trip checks passed with no warnings.

### READY WITH WARNINGS

There are no blocking conditions, but the runtime reported a non-fatal warning such as degraded-but-usable AI health.

### NEEDS ATTENTION

Verification completed and returned trustworthy evidence, but one or more required conditions are not ready.

Missing required Setup Status results fail closed: a missing result remains a `missing` blocker and can never be interpreted as READY.

### VERIFICATION FAILED

The verifier could not complete a trustworthy check, for example because administrator login, transport, or the protected Setup Status request failed. This is kept separate from NEEDS ATTENTION so operators can distinguish “the deployment is known to be unhealthy/incomplete” from “health could not be verified.”

## What READY evaluates

### Business profile

- deployed business type matches the requested industry;
- profile is locked;
- Pipeline profile is aligned;
- conversion profile is aligned;
- lead-temperature profile is aligned;
- Analytics profile is aligned without legacy fallback.

### Core Setup Status

Every required core result must be returned, configured, and `ready`, including:

- database;
- session/security configuration;
- actual public URL;
- administrator account;
- AI reply engine configuration;
- R2/media storage.

Additional returned non-optional, non-channel checks are also treated as required.

### Operational system health

The `systemHealth` payload must also show:

- database/runtime health is healthy;
- database migrations are `up_to_date`;
- inbound processing is healthy;
- AI runtime is available.

An AI runtime error blocks go-live. A degraded-but-usable AI warning results in READY WITH WARNINGS when nothing else blocks readiness.

### Purchased channels

Only purchased channels are elevated to mandatory channel checks, but each one must satisfy both setup and runtime evidence.

Examples:

```text
--channels whatsapp
  -> whatsapp
  -> whatsapp_webhook
  -> real WhatsApp inbound
  -> newer successful WhatsApp outbound
  -> healthy WhatsApp runtime / no newer delivery failure

--channels instagram
  -> instagram
  -> meta_webhook
  -> real Instagram inbound
  -> newer successful Instagram outbound
  -> healthy Instagram runtime / no newer delivery failure

--channels facebook,instagram
  -> facebook
  -> instagram
  -> shared meta_webhook
  -> a valid round trip for each purchased channel
```

Warnings/errors in an unpurchased optional channel do not block READY.

## 3. Complete real channel tests

After infrastructure is live, perform the required real-world channel test for every purchased channel:

- send a WhatsApp message to the business number and confirm the chatbot receives it and replies;
- send a Messenger message to the Page and confirm the chatbot receives it and replies;
- send an Instagram DM and confirm the chatbot receives it and replies.

A webhook alone is not enough for final READY. The successful outbound reply must be newer than the relevant inbound message, and a newer unresolved delivery failure blocks the channel.

## 4. Re-run readiness without reprovisioning

After fixing credentials, runtime issues, or completing real test messages, do **not** rerun provisioning.

Use the receipt written by `provision-client`:

```bash
npm run verify-client -- \
  --receipt .provisioning/acme-cabinets.json \
  --runtime-env-file ./acme.client-runtime.env
```

The receipt supplies the Render URL, expected industry, and purchased channels. The runtime file supplies the administrator credentials needed to authenticate.

You can also run verification without a receipt:

```bash
npm run verify-client -- \
  --url https://da-chatbot-acme-cabinets.onrender.com \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

`verify-client` does not create/delete Render or Neon resources and does not modify chatbot settings, Pipeline data, or messaging data. It authenticates, runs the readiness check, then logs out best-effort.

When `--receipt` is supplied, the command atomically replaces the receipt with the latest readiness result and updates `lastVerifiedAt`. If the receipt cannot be updated, verification output still reports the real readiness result plus a receipt warning.

Its exit codes are:

```text
0 = READY / READY WITH WARNINGS
2 = invalid verifier input
3 = verification completed but NEEDS ATTENTION
4 = login/transport/Setup Status verification could not complete
```

## Resource naming and duplicate protection

By default both cloud resources use:

```text
da-chatbot-<normalized-client-slug>
```

Before creation, the command checks Render and Neon for exact name collisions. Neon search is paginated and fails closed if Neon reports incomplete `unavailable` results.

Execution also holds a same-machine lock at:

```text
.provisioning/<resource-name>.lock
```

Provider-side `409` conflicts remain the second protection layer for races from separate machines.

## Provisioning/readiness receipt

After the cloud deployment is live, the CLI writes:

```text
.provisioning/<client-slug>.json
```

Receipt **version 3** contains recovery/readiness metadata only, including:

- `completedAt`;
- `lastVerifiedAt`;
- client slug;
- industry;
- purchased/required channels;
- Neon project metadata;
- Render service URL/IDs and deploy metadata;
- deployed Git commit SHA when available;
- Render runtime-finalization metadata;
- industry profile contract;
- latest readiness report.

It does **not** contain `DATABASE_URL`, API keys, access tokens, administrator passwords, or copied client runtime values.

If the local receipt cannot be written after Render is already live, the command reports a receipt warning instead of converting successful cloud provisioning into a false provisioning failure.

## Partial failures

Cloud create requests are non-idempotent and are never blindly retried. The provisioner performs no destructive automatic rollback.

### Neon created, Render creation fails

The Neon project is kept and its identifiers are returned for deliberate recovery.

### Render created, initial or final deploy fails

The command reports the failure and preserves the cloud resources for deliberate recovery. It does not silently create replacement infrastructure.

### Infrastructure live, NEEDS ATTENTION

The command returns the live infrastructure result plus the blocking readiness evidence. Common causes include:

- required Setup Status result missing/not configured/not ready;
- business-profile mismatch;
- database migrations not current;
- unhealthy inbound processing;
- AI runtime error;
- purchased channel without a real inbound + newer successful outbound round trip;
- unresolved delivery failure newer than the latest successful outbound.

Fix the condition and run `verify-client` again.

### Infrastructure live, VERIFICATION FAILED

The deployment exists, but the verifier could not establish trustworthy health because login, transport, or Setup Status execution failed. Fix the verifier/access condition and run `verify-client` again; do not reprovision automatically.

## Render build/start/health contract

The defaults match the repository layout:

```text
Build: npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build
Start: npm start
Health check: /
```

The Render health check answers a different question from client readiness:

- Render `live` = the web process is serving;
- READY = the required business/profile/core/operational/channel contract is healthy;
- READY WITH WARNINGS = no blockers, but a non-fatal operational warning remains;
- NEEDS ATTENTION = verification completed and found a blocker;
- VERIFICATION FAILED = readiness could not be reliably established.

A client should only be handed over as go-live ready when the final readiness state is READY or READY WITH WARNINGS and any warning is acceptable to the operator.