# Ops Registry Production Deployment

This runbook turns the Multi-Client Ops Registry into a repeatable production deployment. The registry is an internal DA operator service. It is not part of a customer's normal chatbot portal and must not share a customer database.

## Production architecture

```text
                         DA Chatbot Ops Registry
                         Render service + Neon DB
                                  |
                    read-only readiness polling
                 _____________|______________
                |             |              |
        Client A Render  Client B Render  Client C Render
        Client A Neon    Client B Neon    Client C Neon
```

The registry stores operational metadata and sanitized readiness snapshots only. Customer conversations, contacts, API keys, client database URLs and portal credentials stay in each isolated client deployment.

Normal client services continue to use:

```bash
npm start
```

The central registry uses:

```bash
npm run ops-registry:start
```

## 1. Create a dedicated registry database

Create a separate Neon project/database for the Ops Registry. Do not reuse any client's `DATABASE_URL`.

Copy the PostgreSQL connection string into the registry Render service as:

```text
OPS_DATABASE_URL=...
```

Non-local registry database connections verify TLS certificates by default. Keep:

```text
OPS_DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

Only set it to `false` for an environment where the trust model is explicitly understood and accepted.

## 2. Create the Render service

`render.ops.yaml` contains the intended service shape:

```text
Build command: npm ci
Start command: npm run ops-registry:start
Health check: /healthz
```

The required production secrets are:

```text
OPS_REGISTRY_MODE=true
OPS_DATABASE_URL=<dedicated registry PostgreSQL URL>
OPS_REGISTRY_ADMIN_USERNAME=<operator username>
OPS_REGISTRY_ADMIN_PASSWORD=<generated password, at least 16 characters>
```

Recommended values:

```text
OPS_POLL_INTERVAL_MS=300000
OPS_DATABASE_SSL_REJECT_UNAUTHORIZED=true
OPS_AUTH_TRUST_PROXY=true
```

`PORT` is supplied by Render. `OPS_PORT=10001` is only a fallback for hosts/local runs that do not provide `PORT`.

Do not put WhatsApp, Meta, Gemini, Claude, Telegram, R2 or customer `DATABASE_URL` credentials on this service. The registry does not need them.

## 3. Run registry migrations

Before first production use:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL='...' npm run ops-registry:migrate
```

The startup path also runs the same idempotent migration runner, but running the command explicitly makes first deployment failures easier to diagnose.

## 4. Run preflight verification

Run:

```bash
npm run ops-registry:verify
```

The check validates:

- explicit Ops Registry mode
- registry database configuration
- admin credential requirements
- PostgreSQL connectivity
- registry schema/migration state
- every registered client's token environment variable

It never prints token values or database credentials.

After clients have been registered, an optional read-only network probe is available:

```bash
npm run ops-registry:verify -- --probe-clients
```

The probe calls each client's protected `GET /api/ops/readiness` endpoint and does not update registry snapshots.

## 5. Pair one client with the registry

Generate a unique token for the client:

```bash
npm run ops:generate-token
```

Use the same generated value in exactly two places.

On the client Render service:

```text
OPS_READINESS_TOKEN=<generated value>
```

On the central registry Render service, use the deterministic environment key for that client. For example:

```text
OPS_CLIENT_TOKEN_BELECO_CLINIC=<same generated value>
```

Never put the token in a provisioning receipt, commit, issue, pull request, screenshot or registry database row.

The client endpoint stays unavailable (`404`) when `OPS_READINESS_TOKEN` is absent, so existing deployments remain compatible.

## 6. Register the client deployment

Using the client's provisioning v3 receipt:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL='...' npm run ops:register-client -- \
  --receipt .provisioning/beleco-clinic.json \
  --name "Beleco Clinic"
```

The command stores the client slug, business type, purchased channels, Render metadata, Neon project metadata and the name of the token environment variable. It does not read or store the token value.

A duplicate slug fails by default. Use `--upsert` only when intentionally replacing deployment metadata for an existing client.

After registration, run:

```bash
npm run ops-registry:verify -- --probe-clients
```

Do not consider pairing complete until the client passes the probe.

## 7. Open the dashboard

Render should report `/healthz` as healthy without authentication. The fleet dashboard and APIs require the dedicated Ops Registry Basic Auth credentials.

The dashboard is intended for DA operators only. Keep its URL and credentials out of customer-facing setup material.

The authenticated refresh endpoints additionally require the `X-Ops-Action: 1` header. The bundled dashboard adds this automatically. This prevents a normal cross-site HTML form from causing refresh actions with ambient Basic Auth credentials.

For an intentional API call:

```bash
curl -u "$OPS_REGISTRY_ADMIN_USERNAME:$OPS_REGISTRY_ADMIN_PASSWORD" \
  -H 'X-Ops-Action: 1' \
  -X POST \
  https://<registry-host>/api/refresh-all
```

## 8. Authentication protection

Failed Basic Auth attempts are throttled in memory. Defaults:

```text
OPS_AUTH_MAX_FAILURES=20
OPS_AUTH_WINDOW_MS=300000
```

On the intended Render deployment, set:

```text
OPS_AUTH_TRUST_PROXY=true
```

This allows throttling to use the client address supplied by Render's trusted reverse proxy. Do not enable this when an untrusted caller can directly control `X-Forwarded-For`.

Use a generated high-entropy password even with throttling. If a separate access gateway such as a company VPN or identity-aware proxy is available, placing the internal dashboard behind it is preferred.

## 9. Runtime behavior

The service performs an immediate fleet refresh after startup and then polls on the configured interval. Fleet-wide refreshes are single-flight, so a slow cycle cannot stack another fleet cycle on top of itself.

On `SIGTERM` or `SIGINT`, the registry:

1. stops scheduling new fleet refreshes
2. stops accepting new HTTP connections
3. waits for the active fleet refresh, if any
4. closes the PostgreSQL pool

This matches Render's normal termination flow and reduces partial shutdown behavior during deployments.

## 10. Production acceptance checklist

Before depending on the registry operationally, confirm all of the following:

- registry has its own Neon/PostgreSQL database
- `OPS_REGISTRY_MODE=true` exists only on the central registry service
- `/healthz` returns `200`
- unauthenticated fleet API requests return `401`
- `npm run ops-registry:verify` passes
- every registered client has a unique readiness token
- `npm run ops-registry:verify -- --probe-clients` passes
- dashboard shows the expected client slug, channels and readiness
- stopping one test client marks only that client offline
- restarting the registry restores polling without changing client data
- no customer conversations or credentials appear in the registry database or API responses

## Rollback

The Ops Registry is optional to client operation. If the registry deployment has a problem, stop or roll back only the registry Render service. Client chatbots continue running independently.

Do not roll back or restart customer deployments merely because the central registry is unavailable. The registry is an observer, not part of the customer messaging path.
