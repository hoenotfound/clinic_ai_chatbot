# Multi-Client Ops Registry

The Ops Registry is a separate read-only control-plane deployment for viewing readiness across isolated DA Chatbot client instances.

## Isolation model

Each customer keeps its existing isolated runtime:

- one client Render service
- one client Neon database
- customer conversations and contacts remain only in that client database

The Ops Registry uses a separate `OPS_DATABASE_URL`. Its database stores only operational metadata and the latest sanitized readiness snapshot. It does **not** store customer conversations, contacts, phone numbers, Meta/Gemini/Claude credentials, client `DATABASE_URL` values, client administrator passwords, or session secrets.

Normal client deployments keep using `npm start`. The control-plane process uses `npm run ops-registry:start` and refuses to start unless `OPS_REGISTRY_MODE=true` is set. This prevents an ordinary client deployment from accidentally becoming the fleet dashboard.

## Client readiness endpoint

Set a unique, high-entropy value on each client:

```text
OPS_READINESS_TOKEN=<at least 32 characters>
```

Generate one with:

```bash
npm run ops:generate-token
```

When the token is absent, `/api/ops/readiness` behaves as unavailable (`404`). Existing clients therefore keep operating normally without Ops Registry configuration. When configured, the endpoint accepts only:

```text
Authorization: Bearer <OPS_READINESS_TOKEN>
```

The endpoint is GET-only and does not use the portal administrator session. Its `schemaVersion: 1` response is a sanitized projection of the existing Unified Go-Live Gate, using the normal non-running Go-Live load path. It does not trigger `/api/go-live/run` and does not build a second readiness evaluator.

Only purchased channels are returned in channel readiness. Facebook and Instagram remain independent channel records even though they share Meta webhook infrastructure.

## Registry service environment

Required:

```text
OPS_REGISTRY_MODE=true
OPS_DATABASE_URL=<dedicated registry postgres>
OPS_REGISTRY_ADMIN_USERNAME=<operator username>
OPS_REGISTRY_ADMIN_PASSWORD=<strong password, minimum 16 chars>
```

Optional:

```text
OPS_POLL_INTERVAL_MS=300000
OPS_PORT=10001
```

For every registered client, configure the registry service with the environment variable named by that client's `token_env_key`. Example:

```text
OPS_CLIENT_TOKEN_BELECO_CLINIC=<same value as Beleco's OPS_READINESS_TOKEN>
```

The registry database stores only `OPS_CLIENT_TOKEN_BELECO_CLINIC`, not its value.

PR #117 deliberately does not auto-generate the client token during provisioning. Render can generate a secret for one service, but the same secret must also reach the separate registry deployment. Until there is a secure secret handoff between those deployments, automatic generation would either make pairing impossible or tempt secret leakage into the provisioning receipt. The v1 flow therefore generates the token explicitly and configures the two secret environments out of band. The receipt remains secret-free.

Provisioning does set `CLIENT_SLUG` for new clients so the machine endpoint can report a stable deployment identity. Existing deployments without it remain compatible; identity is nullable and the chatbot itself does not depend on the registry.

## Registry schema and migrations

The control-plane database has its own migration namespace under:

```text
src/ops/migrations/
```

It is intentionally separate from `src/db/migrations/`, which belongs to each client chatbot database. This prevents central registry tables from being created in every customer Neon database.

Run the control-plane migrations with:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL=... npm run ops-registry:migrate
```

The registry service also runs the same idempotent migration runner at startup.

## Registering a provisioned client

Provisioning receipts remain secret-free. Register a new client with:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL=... npm run ops:register-client -- \
  --receipt .provisioning/beleco-clinic.json \
  --name "Beleco Clinic"
```

The command imports:

- stable client slug
- business industry
- purchased channels
- Render URL/service ID
- Neon project ID
- provisioned commit SHA

A duplicate client slug is rejected by default. To intentionally replace the registered deployment metadata for an existing slug, add `--upsert`.

## Running the registry

```bash
OPS_REGISTRY_MODE=true npm run ops-registry:start
```

The service exposes:

- `GET /healthz` - unauthenticated health endpoint for Render
- `GET /` - Basic-authenticated fleet dashboard
- `GET /clients/:clientSlug` - Basic-authenticated client detail view
- `GET /api/clients` - Basic-authenticated fleet snapshot
- `GET /api/clients/:clientSlug` - Basic-authenticated client detail JSON
- `POST /api/clients/:clientSlug/refresh` - refresh one client's read-only readiness snapshot
- `POST /api/refresh-all` - refresh all clients with bounded concurrency

The POST routes cause the registry to perform GET readiness polls only. They do not mutate a client chatbot, restart it, redeploy it, change configuration, or run technical Go-Live checks remotely.

Client polling requires HTTPS except for localhost development and has a bounded timeout. One client's polling error is isolated from the rest of the fleet.

## Status model

The registry preserves the Unified Go-Live Gate readiness statuses:

- `ready`
- `ready_with_warnings`
- `needs_testing`
- `blocked`

The fleet adds `offline` for connectivity. A failed current poll, including a timeout, marks the client offline immediately. A stale last-success timestamp also marks it offline. In both cases the previous successful readiness snapshot and `lastKnownReadinessStatus` are retained for diagnosis instead of being erased.

This keeps two different facts visible at the same time. For example, a client can be currently offline while its last known Go-Live state was `ready`.

## Version visibility

Render exposes `RENDER_GIT_COMMIT` to running services. The client readiness endpoint includes that commit SHA, plus safe app version/start metadata, and the registry compares the deployed SHA with its own deployed commit when available.

Version state is intentionally conservative in v1:

- `current` - exact SHA match
- `different` - exact SHA differs
- `unknown` - one side does not expose a commit

Counting exact commits behind `main` is deferred until the registry has an explicit GitHub read integration. Version drift is visibility only and does not block Go-Live.
