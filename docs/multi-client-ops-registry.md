# Multi-Client Ops Registry

The Ops Registry is a separate read-only control-plane deployment for viewing readiness across isolated DA Chatbot client instances.

## Isolation model

Each customer keeps its existing isolated runtime:

- one client Render service
- one client Neon database
- customer conversations and contacts remain only in that client database

The Ops Registry uses a separate `OPS_DATABASE_URL`. Its database stores only operational metadata and the latest sanitized readiness snapshot. It does **not** store customer conversations, contacts, Meta/Gemini credentials, client `DATABASE_URL` values, or client administrator passwords.

## Client readiness endpoint

Set a unique, high-entropy value on each client:

```text
OPS_READINESS_TOKEN=<at least 32 characters>
```

Generate one with:

```bash
npm run ops:generate-token
```

When the token is absent, `/api/ops/readiness` behaves as unavailable (`404`). When configured, the endpoint accepts only:

```text
Authorization: Bearer <OPS_READINESS_TOKEN>
```

The response is a sanitized `schemaVersion: 1` snapshot of the merged Go-Live Gate plus the Render commit SHA. It does not return customer data or provider credentials.

## Registry service environment

Required:

```text
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

## Registering a provisioned client

Provisioning receipts remain secret-free. Register one with:

```bash
OPS_DATABASE_URL=... npm run ops:register-client -- \
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

It prints the central token environment-variable name to configure.

## Running the registry

```bash
npm run ops-registry:start
```

The service exposes:

- `GET /healthz` — unauthenticated health endpoint for Render
- `GET /` — Basic-authenticated fleet dashboard
- `GET /api/clients` — Basic-authenticated fleet snapshot
- `POST /api/clients/:clientSlug/refresh` — refresh one client's read-only readiness snapshot
- `POST /api/refresh-all` — refresh all clients with bounded concurrency

Client polling requires HTTPS except for localhost development.

## Status model

The registry preserves the Go-Live Gate status:

- `ready`
- `ready_with_warnings`
- `needs_testing`
- `blocked`

A client becomes `offline` in the fleet view when no successful poll has been observed recently. Poll failures do not erase the last known successful readiness snapshot.

## Version visibility

Render exposes `RENDER_GIT_COMMIT` to running services. The client readiness endpoint includes that commit SHA, and the registry compares it with its own deployed commit when available.

Version state is intentionally conservative in v1:

- `current` — exact SHA match
- `different` — exact SHA differs
- `unknown` — one side does not expose a commit

Counting "commits behind main" is deferred until the registry has an explicit GitHub read integration.
