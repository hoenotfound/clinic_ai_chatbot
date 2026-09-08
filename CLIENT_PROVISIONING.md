# Client provisioning

This repo includes an internal provisioning command for the deployment model used by the production chatbot:

```text
one client
  -> one Render web service
  -> one Neon project/database
  -> one explicit chatbot industry profile
```

The provisioner is intentionally conservative. Its normal mode is a dry-run plan. Actual cloud resources are created only when `--execute` is supplied.

## What PR #105 automates

For a new client, the command:

1. requires an explicit business industry;
2. checks Render and Neon for an exact resource-name collision;
3. creates a Neon project in the selected region;
4. waits for Neon's create operations to finish;
5. retrieves a **pooled** Neon PostgreSQL connection URI;
6. creates the Render Node web service from this repository;
7. injects `DATABASE_URL` plus a Render-generated `SESSION_SECRET`;
8. injects the canonical `INITIAL_BUSINESS_TYPE` before the application's first startup.

That last step connects provisioning to the atomic industry onboarding introduced in PR #104. Because the industry is supplied explicitly through the provisioning environment, the newly seeded profile is authoritative and locked on first startup rather than appearing later as a switchable default clinic profile.

Supported canonical profiles are currently:

- `aesthetic_clinic`
- `home_renovation`
- `generic`

Aliases accepted by the application profile resolver, such as `renovation`, `carpentry`, and `cabinetry`, are normalized before any cloud operation. Provisioning never silently falls back to Aesthetic Clinic when the industry argument is missing.

## Control-plane credentials

Keep these in your local shell or another secure operator environment. Do **not** put them in the client's Render runtime environment or commit them to Git.

```bash
export PROVISIONING_RENDER_API_KEY="..."
export PROVISIONING_RENDER_OWNER_ID="..."
export PROVISIONING_NEON_API_KEY="..."
# Needed when using a Neon personal API key for an organization project.
export PROVISIONING_NEON_ORG_ID="..."
```

A Render plan must also be chosen explicitly before execution so the script cannot make a billing choice on your behalf:

```bash
export PROVISIONING_RENDER_PLAN="starter"
```

Use the plan that is appropriate for the client. You can also supply it with `--render-plan`.

Optional operator defaults:

```bash
export PROVISIONING_RENDER_REGION="singapore"
export PROVISIONING_NEON_REGION="aws-ap-southeast-1"
export PROVISIONING_RENDER_REPO="https://github.com/hoenotfound/clinic_ai_chatbot"
export PROVISIONING_RENDER_BRANCH="main"
export PROVISIONING_RESOURCE_PREFIX="da-chatbot"
```

The code defaults Render to Singapore, Neon to the AWS Singapore region, this production repository, `main`, and the `da-chatbot` resource prefix.

## App runtime configuration

Client-specific app variables can be loaded from a local dotenv file:

```bash
# acme.client-runtime.env
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

The file can contain whichever runtime variables the client actually needs. The provisioner never prints their values.

The following app keys are owned by provisioning and are rejected if they appear in the runtime file:

- `DATABASE_URL`
- `SESSION_SECRET`
- `INITIAL_BUSINESS_TYPE`
- `BUSINESS_TYPE`
- `PORT`

In addition, **every key beginning with `PROVISIONING_` is rejected** from the client runtime file. Those variables belong to the operator/control plane and must never be copied into a client's Render service.

This prevents a client env file from overriding the database/business-profile contract or leaking Render/Neon provisioning credentials into the client runtime.

Local provisioning/runtime env filename patterns are included in `.gitignore`, but you should still treat these files as secrets and store/remove them appropriately.

## 1. Review a dry-run plan

Home renovation example:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env
```

No Render or Neon request is made in this mode. Example plan output:

```text
Client:        acme-cabinets
Industry:      home_renovation
Neon project:  da-chatbot-acme-cabinets (aws-ap-southeast-1)
Render service:da-chatbot-acme-cabinets (singapore)
Profile env:   INITIAL_BUSINESS_TYPE=home_renovation
```

Only runtime **key names** are shown. Secret values are not included in the plan.

## 2. Execute after review

Run the same command with `--execute`:

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env \
  --execute
```

For scripts/automation, add `--json` for machine-readable output.

## Resource naming and duplicate protection

By default both resources use:

```text
da-chatbot-<normalized-client-slug>
```

Before creating anything, the command checks:

- Render services in the configured workspace;
- Neon projects in the configured Neon account/organization.

An exact name collision stops provisioning before any create request.

This is deliberate. The provisioner does not guess whether an existing resource belongs to a previous successful run, an abandoned attempt, or another client.

## Partial failures

Cloud create requests are non-idempotent. A retry after a network failure can otherwise create duplicate resources.

The provisioner therefore does **not** blindly retry create requests.

If Neon succeeds but Render fails:

- the Neon project is **not deleted automatically**;
- the error includes the Neon project ID/name;
- inspect the Render failure and the preserved Neon project;
- deliberately finish or clean up the incomplete provisioning before trying again.

If a Neon create call fails ambiguously because the network response is lost, rerun the command only after its preflight confirms whether the expected Neon project name now exists.

The command never performs destructive rollback automatically.

## Render build/start contract

The default commands match the current repository layout:

```text
Build: npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build
Start: npm start
```

The backend serves the built portal from `portal-frontend/dist` in production.

If deployment structure changes later, update the provisioner defaults together with the normal deployment instructions and regression tests.

## Relationship to Setup Status

There are now two valid fresh-client paths:

### Provisioned client

The provisioner sets:

```text
INITIAL_BUSINESS_TYPE=<chosen profile>
```

The first startup seeds and locks that profile immediately.

### Manually created fresh deployment

If `INITIAL_BUSINESS_TYPE` is omitted, the application still starts from its backward-compatible Aesthetic Clinic default and exposes the one-time Business Profile selector in Setup Status while the deployment is untouched.

The provisioner is the preferred path for repeatable client creation because it removes the window where an operator could create the Render/Neon pair but forget to choose the intended industry.
