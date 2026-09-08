# Client provisioning and readiness

This repo includes an internal operator workflow for the production deployment model:

```text
one client
  -> one Render web service
  -> one Neon project/database
  -> one explicit chatbot industry profile
  -> one explicit required-channel contract
  -> post-provision readiness verification
```

The workflow is conservative. Provisioning is a dry run unless `--execute` is supplied. Readiness verification never deletes infrastructure, edits client configuration, or sends customer-facing messages.

## What provisioning automates

For a new client, `provision-client`:

1. requires an explicit business industry;
2. requires the messaging channels the client actually bought;
3. validates deterministic Render choices locally before any cloud call;
4. checks Render and Neon for an exact resource-name collision;
5. creates a Neon project in the selected region;
6. waits for Neon's create operations to finish;
7. retrieves a **pooled** Neon PostgreSQL connection URI;
8. creates the Render Node web service from this repository;
9. injects `DATABASE_URL` plus a Render-generated `SESSION_SECRET`;
10. injects the canonical `INITIAL_BUSINESS_TYPE` before first startup;
11. configures Render's health check to use `/`;
12. waits for the initial Render deploy to reach `live`;
13. signs into the new portal with the bootstrap administrator;
14. runs the existing protected Setup Status checks;
15. verifies the locked industry profile and only the purchased channels;
16. writes a local secret-free recovery/readiness receipt.

Provisioning and readiness use the same application Setup Status model the admin portal uses. There is no separate hidden health-check implementation.

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

before first startup, so the new deployment seeds and locks the correct profile immediately.

## Required messaging channels

Provisioning also requires an explicit channel contract:

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

Only channels listed in `--channels` block go-live readiness. An unconfigured channel the client did not buy is reported by normal Setup Status but does not make the client fail the provisioning readiness contract.

Channel readiness intentionally uses real application evidence:

- WhatsApp requires its API connection plus signed webhook evidence;
- Messenger requires the Page connection plus Meta webhook/customer-message evidence;
- Instagram requires the Instagram connection plus Meta webhook/customer-message evidence.

This means a newly created deployment can legitimately finish with:

```text
Infrastructure: LIVE
Readiness: NEEDS ATTENTION
```

until you send/receive the required test message. Infrastructure is not rolled back.

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

Render plan/region values are validated before Neon is created so simple typos cannot create a partial installation first.

## Client runtime configuration

Client-specific application variables come from a local dotenv file, for example:

```bash
# acme.client-runtime.env
AI_PROVIDER=gemini
GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...

# Required for the initial administrator and automated readiness login.
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

For `--execute`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` must be present in this runtime file. The same values are copied to the client runtime for the one-time bootstrap admin behavior and used locally to authenticate the readiness check.

Passwords are intentionally **not** accepted as readiness CLI flags so they do not enter normal shell history.

The following keys are owned by provisioning and are rejected from runtime input:

- `DATABASE_URL`
- `SESSION_SECRET`
- `INITIAL_BUSINESS_TYPE`
- `BUSINESS_TYPE`
- `PORT`

Every key beginning with `PROVISIONING_` is also rejected from the client runtime file.

Provider/CLI error messages are redacted against client runtime secrets, control-plane tokens, bearer credentials, and PostgreSQL connection URIs.

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

## 2. Execute provisioning + first readiness check

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

The command only considers infrastructure provisioned after the initial Render deploy is `live`. It then signs in to the new portal and runs `POST /api/setup-status/run` through the normal administrator session.

### Exit codes

```text
0 = dry-run or provisioned + READY
2 = validation/provisioning failure
3 = infrastructure is live, but readiness NEEDS ATTENTION
```

Exit code `3` is deliberately different from a provisioning failure. Do not delete/recreate the deployment just because a required channel is waiting for its first signed webhook or test conversation.

## What READY means

The readiness evaluator requires:

### Business profile

- deployed business type matches the requested industry;
- profile is locked;
- Pipeline profile is aligned;
- conversion profile is aligned;
- lead-temperature profile is aligned;
- Analytics profile is aligned without fallback.

### Core application

Every non-optional non-channel Setup Status check must be `ready`, currently including the database, session security, public URL, administrator account, AI reply engine, and media storage.

### Purchased channels

Only the checks for `--channels` are elevated to mandatory readiness checks.

Examples:

```text
--channels whatsapp
  -> whatsapp
  -> whatsapp_webhook

--channels instagram
  -> instagram
  -> meta_webhook

--channels facebook,instagram
  -> facebook
  -> instagram
  -> meta_webhook
```

Warnings and errors in an unpurchased optional channel do not block READY.

## 3. Complete real channel tests

After the infrastructure is live, perform the required real-world channel test:

- send a WhatsApp message to the business number and confirm the chatbot receives/replies;
- send a Messenger message to the Page and confirm inbound/reply behavior;
- send an Instagram DM and confirm inbound/reply behavior.

These real inbound events provide the webhook evidence Setup Status uses.

## 4. Re-run readiness without reprovisioning

After fixing credentials or completing test messages, do **not** rerun provisioning.

Use the secret-free receipt written by `provision-client`:

```bash
npm run verify-client -- \
  --receipt .provisioning/acme-cabinets.json \
  --runtime-env-file ./acme.client-runtime.env
```

The receipt supplies the Render URL, expected industry, and required channels. The runtime file supplies only the admin credentials needed to authenticate.

You can also run verification without a receipt:

```bash
npm run verify-client -- \
  --url https://da-chatbot-acme-cabinets.onrender.com \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

`verify-client` does not create/delete Render or Neon resources and does not modify chatbot settings or Pipeline data. It authenticates, runs Setup Status, evaluates the result, then logs out best-effort.

Its exit codes are:

```text
0 = READY
2 = verifier/input/auth/transport failure
3 = verification completed but NEEDS ATTENTION
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

Receipt version 2 contains only recovery/readiness metadata:

- client slug;
- industry;
- required channels;
- Neon project ID/name/region;
- Render service ID/name/URL;
- initial deploy ID/status;
- Render plan/region/repo/branch;
- industry profile contract;
- the latest readiness report.

It does **not** contain `DATABASE_URL`, API keys, tokens, admin passwords, or client runtime values.

If the local receipt cannot be written after Render is already live, the command reports a receipt warning but does not convert successful cloud provisioning into a false provisioning failure.

## Partial failures

Cloud create requests are non-idempotent and are never blindly retried. The provisioner performs no destructive automatic rollback.

### Neon created, Render creation fails

The Neon project is kept and its identifiers are returned for deliberate recovery.

### Render created, initial deploy fails

The command reports `RENDER_DEPLOY_FAILED` and returns Neon project ID/name plus Render service/deploy IDs. Both resources remain intact.

### Infrastructure live, readiness fails

The command returns the live infrastructure result plus a readiness report with `status: needs_attention`. This is not a reason to recreate the infrastructure.

Common causes include:

- wrong admin credentials;
- AI/media credentials not ready;
- requested business profile mismatch;
- Meta/WhatsApp credentials incomplete;
- required signed webhook/customer-message evidence not received yet.

Fix the setup/test issue and run `verify-client` again.

## Render build/start/health contract

The defaults match the repository layout:

```text
Build: npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build
Start: npm start
Health check: /
```

The Render health check answers a different question from client readiness:

- Render `live` = the web process is serving;
- readiness `READY` = the chatbot's required business/profile/core/channel contract is usable.

Both are required before handing the client over as go-live ready.
