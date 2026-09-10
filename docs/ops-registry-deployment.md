# Ops Registry Production Deployment

This runbook turns the Multi-Client Ops Registry into a repeatable production deployment. The registry is an internal DA operator service. It is not part of a customer's normal chatbot portal and must not share a customer database.

## Production architecture

```text
                         DA Chatbot Ops Registry
                       Render Singapore + Neon SG
                                  |
                    read-only readiness polling
                 _____________|______________
                |             |              |
        Client A Render  Client B Render  Client C Render
        Client A Neon    Client B Neon    Client C Neon
```

The registry stores operational metadata and sanitized readiness snapshots only. Customer conversations, contacts, API keys, client database URLs and portal credentials stay in each isolated client deployment.

Normal client services continue to use `npm start`. The central registry uses `npm run ops-registry:start`.

## 1. Create the dedicated registry database

Create a separate Neon project/database in `aws-ap-southeast-1` / Singapore for the Ops Registry. Do not reuse any client's `DATABASE_URL`.

Set the connection string on the registry Render service as:

```text
OPS_DATABASE_URL=...
```

Keep production TLS verification enabled:

```text
OPS_DATABASE_SSL_REJECT_UNAUTHORIZED=true
```

Only set it to `false` for an environment where the trust model is explicitly understood and accepted.

The registry also bounds database waits by default:

```text
OPS_DATABASE_CONNECTION_TIMEOUT_MS=5000
OPS_DATABASE_QUERY_TIMEOUT_MS=10000
OPS_DATABASE_POOL_MAX=5
```

## 2. Create the Render Blueprint service

In Render choose **New -> Blueprint**, select this repository and branch `main`, then explicitly set the Blueprint file path to:

```text
render.ops.yaml
```

The custom path matters because the normal Render convention is `render.yaml`.

The Blueprint intentionally pins:

```text
Region: Singapore
Instances: 1
Build: npm ci
Pre-deploy: npm run ops-registry:migrate
Start: npm run ops-registry:start
Health check: /healthz
Auto deploy: after checks pass
Shutdown delay: 120 seconds
```

Keep the registry at one instance until polling leadership and auth throttling use shared/distributed coordination.

Required production secrets:

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
OPS_SHUTDOWN_GRACE_MS=100000
```

`PORT` is supplied by Render. `OPS_PORT=10001` is only a fallback for hosts/local runs that do not provide `PORT`.

Do not put WhatsApp, Meta, Gemini, Claude, Telegram, R2 or customer `DATABASE_URL` credentials on this service. The registry does not need them.

## 3. Migrations

The Render Blueprint runs:

```bash
npm run ops-registry:migrate
```

as a pre-deploy command. The startup path also uses the same idempotent migration runner as a safety net.

For local/manual diagnosis you can still run:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL='...' npm run ops-registry:migrate
```

Migration `002_unique_token_env_key.sql` enforces one registry token environment key per client. If an older registry contains duplicates, migration should fail rather than silently preserve an ambiguous credential mapping.

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
- token environment key uniqueness
- token value uniqueness using in-memory fingerprints only

The preflight redacts database URLs, admin passwords and client token values from displayed errors.

After clients have been registered, perform read-only network probes:

```bash
npm run ops-registry:verify -- --probe-clients
```

The probe calls each client's protected `GET /api/ops/readiness` endpoint without updating registry snapshots. A registered client must return an exact `client.slug` match. Missing or mismatched client identity fails the probe.

## 5. Pair one client with the registry

Generate a unique token:

```bash
npm run ops:generate-token
```

Use the generated value in exactly two places.

On the client Render service:

```text
OPS_READINESS_TOKEN=<generated value>
```

On the central registry Render service, use the deterministic environment key for that client, for example:

```text
OPS_CLIENT_TOKEN_BELECO_CLINIC=<same generated value>
```

Every client must use a different token environment key and a different token value. Never put the token in a provisioning receipt, commit, issue, pull request, screenshot or registry database row.

The client readiness endpoint stays unavailable (`404`) when `OPS_READINESS_TOKEN` is absent, so existing deployments remain compatible.

## 6. Register the client deployment

Using the client's provisioning v3 receipt:

```bash
OPS_REGISTRY_MODE=true OPS_DATABASE_URL='...' npm run ops:register-client -- \
  --receipt .provisioning/beleco-clinic.json \
  --name "Beleco Clinic"
```

The command stores only operational metadata and the token environment-variable name. A duplicate client slug fails by default; use `--upsert` only when intentionally replacing deployment metadata. Reusing another client's token environment key is rejected.

After registration run:

```bash
npm run ops-registry:verify -- --probe-clients
```

Do not consider pairing complete until the probe confirms the exact client identity.

## 7. Open the dashboard

`/healthz` is intentionally public for Render health checks. The fleet dashboard and fleet APIs require dedicated Ops Registry Basic Auth credentials.

The dashboard is DA-internal. Keep its URL and credentials out of customer-facing setup material.

Authenticated refresh endpoints additionally require:

```text
X-Ops-Action: 1
```

and reject cross-site Fetch Metadata. The bundled dashboard sends the header automatically.

Intentional API refresh example:

```bash
curl -u "$OPS_REGISTRY_ADMIN_USERNAME:$OPS_REGISTRY_ADMIN_PASSWORD" \
  -H 'X-Ops-Action: 1' \
  -X POST \
  https://<registry-host>/api/refresh-all
```

## 8. Authentication protection

Failed Basic Auth attempts are throttled per source address and stored in a bounded in-memory map:

```text
OPS_AUTH_MAX_FAILURES=20
OPS_AUTH_WINDOW_MS=300000
OPS_AUTH_MAX_TRACKED_ADDRESSES=1000
```

On Render set:

```text
OPS_AUTH_TRUST_PROXY=true
```

Only enable trusted-proxy address extraction when the service is actually behind a trusted reverse proxy that owns `X-Forwarded-For`.

Use a generated high-entropy password. If a company VPN or identity-aware access gateway becomes available, placing the internal dashboard behind it is preferred.

## 9. Polling and freshness

The default polling interval is five minutes:

```text
OPS_POLL_INTERVAL_MS=300000
```

The offline/stale threshold is derived as:

```text
max(15 minutes, 3 x polling interval)
```

This prevents a healthy client from being marked offline merely because an operator configured a slower polling interval.

Fleet refreshes are single-flight, and each individual client refresh is also single-flight. Database poll writes include a timestamp guard so an older poll cannot overwrite a newer result even if multiple processes ever race.

## 10. Shutdown behavior

The Blueprint grants 120 seconds for graceful shutdown while the application uses a smaller internal default:

```text
OPS_SHUTDOWN_GRACE_MS=100000
```

On `SIGTERM` or `SIGINT`, the registry:

1. stops scheduling new fleet refreshes
2. aborts active background client probes
3. stops accepting new HTTP connections
4. waits within the internal grace deadline
5. closes remaining HTTP connections if that deadline is reached
6. closes the PostgreSQL pool

Client polling requests remain independently bounded by their normal request timeout.

## 11. Smoke-test the deployed registry

After Render reports the deployment healthy, verify the actual public deployment:

```bash
OPS_REGISTRY_ADMIN_USERNAME='...' \
OPS_REGISTRY_ADMIN_PASSWORD='...' \
npm run ops-registry:smoke -- --url https://<registry-host>
```

The admin password is intentionally read from the environment rather than a CLI flag.

The smoke test confirms:

- HTTPS/public health endpoint is reachable
- unauthenticated fleet access returns `401`
- authenticated fleet API returns schema version 1
- security headers are present and CSP does not allow unsafe inline scripts
- refresh POSTs without the explicit action confirmation are rejected

It does not trigger a fleet refresh.

## 12. Production acceptance checklist

Before depending on the registry operationally, confirm all of the following:

- registry Render service is in Singapore
- registry has its own Singapore Neon/PostgreSQL database
- Blueprint path is `render.ops.yaml`
- `OPS_REGISTRY_MODE=true` exists only on the central registry service
- registry runs exactly one instance
- pre-deploy migrations succeed
- `/healthz` returns `200`
- unauthenticated fleet API requests return `401`
- `npm run ops-registry:verify` passes
- every registered client has a unique readiness token and token env key
- `npm run ops-registry:verify -- --probe-clients` passes with exact client identities
- `npm run ops-registry:smoke -- --url ...` passes
- dashboard shows expected client slugs, channels and readiness
- stopping one test client marks only that client offline
- restarting the registry restores polling without changing client data
- no customer conversations or credentials appear in the registry database or API responses

## Rollback

The Ops Registry is optional to client operation. If the registry deployment has a problem, stop or roll back only the registry Render service. Client chatbots continue independently.

Do not roll back or restart customer deployments merely because the central registry is unavailable. The registry is an observer, not part of the customer messaging path.
