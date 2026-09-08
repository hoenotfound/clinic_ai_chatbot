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
2. validates deterministic Render choices locally before any cloud call;
3. checks Render and Neon for an exact resource-name collision;
4. creates a Neon project in the selected region;
5. waits for Neon's create operations to finish;
6. retrieves a **pooled** Neon PostgreSQL connection URI;
7. creates the Render Node web service from this repository;
8. injects `DATABASE_URL` plus a Render-generated `SESSION_SECRET`;
9. injects the canonical `INITIAL_BUSINESS_TYPE` before the application's first startup;
10. configures Render's health check to use the app's existing `/` endpoint;
11. waits for the initial Render deploy to reach `live` before reporting provisioning success;
12. writes a local secret-free recovery receipt after success.

The industry step connects provisioning to the atomic industry onboarding introduced in PR #104. Because the industry is supplied explicitly through the provisioning environment, the newly seeded profile is authoritative and locked on first startup rather than appearing later as a switchable default clinic profile.

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

The provisioner validates Render plan and region names locally before creating Neon. This prevents simple typos such as `singpore` or `statrer` from creating a partial client installation first.

Current Render regions accepted by the provisioner are:

- `frankfurt`
- `oregon`
- `ohio`
- `singapore`
- `virginia`

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

The file can contain whichever runtime variables the client actually needs. The provisioner never intentionally prints their values.

The following app keys are owned by provisioning and are rejected if they appear in the runtime file:

- `DATABASE_URL`
- `SESSION_SECRET`
- `INITIAL_BUSINESS_TYPE`
- `BUSINESS_TYPE`
- `PORT`

In addition, **every key beginning with `PROVISIONING_` is rejected** from the client runtime file. Those variables belong to the operator/control plane and must never be copied into a client's Render service.

Provider error messages are also redacted against client runtime secrets, Render/Neon control-plane tokens, bearer credentials, and PostgreSQL connection URIs before they reach normal CLI/JSON output.

Local provisioning/runtime env filename patterns and `.provisioning/` state are included in `.gitignore`, but you should still treat the original runtime env files as secrets and store/remove them appropriately.

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
Render plan:   starter
Health check:  /
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

The command does **not** print `Client provisioning completed` immediately after Render accepts service creation. It polls the returned initial deploy and reports success only after Render says that deploy is `live`.

## Resource naming and duplicate protection

By default both resources use:

```text
da-chatbot-<normalized-client-slug>
```

Before creating anything, the command checks:

- Render services in the configured workspace;
- Neon projects in the configured Neon account/organization.

Neon project search is paginated and fails closed if Neon reports incomplete `unavailable` results. An exact name collision stops provisioning before any create request.

This is deliberate. The provisioner does not guess whether an existing resource belongs to a previous successful run, an abandoned attempt, or another client.

### Concurrent operators

Execution creates a same-machine lock under:

```text
.provisioning/<resource-name>.lock
```

A second local process attempting the same resource name is refused while the first process is still running. Stale lock files from dead processes are recovered automatically.

This lock cannot coordinate two completely separate machines. Provider-side conflicts are therefore also classified explicitly: a `409` from Neon or Render is treated as a race/resource collision and is **not** presented as a normal retryable failure.

## Successful provisioning receipt

After Neon is ready and the initial Render deploy is `live`, the CLI writes:

```text
.provisioning/<client-slug>.json
```

The receipt is intentionally secret-free. It records useful recovery/support information such as:

- completion time;
- client slug and industry;
- Neon project ID/name/region;
- Render service ID/name/URL;
- initial Render deploy ID/status;
- Render region/plan/repository/branch;
- the applied industry profile contract.

It does **not** contain `DATABASE_URL`, API keys, tokens, passwords, or runtime env values.

## Partial failures

Cloud create requests are non-idempotent. A retry after a network failure can otherwise create duplicate resources.

The provisioner therefore does **not** blindly retry create requests and never performs destructive automatic rollback.

### Neon created, Render creation fails

- the Neon project is **not deleted automatically**;
- the error includes the Neon project ID/name;
- inspect the Render failure and the preserved Neon project;
- deliberately finish or clean up the incomplete provisioning before trying again.

### Render service created, initial deploy fails

The command reports `RENDER_DEPLOY_FAILED` instead of claiming success. The structured error includes:

- Neon project ID/name;
- Render service ID/name;
- initial Render deploy ID.

Both resources remain intact for inspection and deliberate recovery.

### Provider response lost

If a non-idempotent create call fails ambiguously because the network response is lost, do not blindly repeat it. Re-run only after checking whether the deterministic resource name now exists.

## Render build/start/health contract

The default commands match the current repository layout:

```text
Build: npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build
Start: npm start
Health check: /
```

The backend already serves `/`, so no new application health endpoint is required. The backend also serves the built portal from `portal-frontend/dist` in production.

If deployment structure changes later, update the provisioner defaults together with the normal deployment instructions and regression tests.

## Relationship to Setup Status

There are now two valid fresh-client paths:

### Provisioned client

The provisioner sets:

```text
INITIAL_BUSINESS_TYPE=<chosen profile>
```

The first successful startup seeds and locks that profile immediately.

### Manually created fresh deployment

If `INITIAL_BUSINESS_TYPE` is omitted, the application still starts from its backward-compatible Aesthetic Clinic default and exposes the one-time Business Profile selector in Setup Status while the deployment is untouched.

The provisioner is the preferred path for repeatable client creation because it removes the window where an operator could create the Render/Neon pair but forget to choose the intended industry.
