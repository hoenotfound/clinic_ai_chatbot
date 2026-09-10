# Multi-Client Ops Registry

The Ops Registry is a separate read-only control-plane deployment for viewing readiness across isolated DA Chatbot client instances.

## Isolation model

Each customer keeps its existing isolated runtime:

- one client Render service
- one client Neon database
- customer conversations and contacts remain only in that client database

The Ops Registry uses a separate `OPS_DATABASE_URL`. Its database stores only operational metadata and the latest sanitized readiness snapshot. It does **not** store customer conversations, contacts, phone numbers, Meta/Gemini/Claude credentials, client `DATABASE_URL` values, client administrator passwords, session secrets, or Ops token values.

Normal client deployments keep using `npm start`. The control-plane process uses `npm run ops-registry:start` and refuses to start unless `OPS_REGISTRY_MODE=true` is set. This prevents an ordinary client deployment from accidentally becoming the fleet dashboard.

## Client readiness endpoint

Each client uses a unique, high-entropy value in:

```text
OPS_READINESS_TOKEN=<at least 32 characters>
```

When the token is absent, `/api/ops/readiness` behaves as unavailable (`404`). Existing clients therefore keep operating normally without Ops Registry configuration. When configured, the endpoint accepts only:

```text
Authorization: Bearer <OPS_READINESS_TOKEN>
```

The endpoint is GET-only and does not use the portal administrator session. Its `schemaVersion: 1` response is a sanitized projection of the existing Unified Go-Live Gate, using the normal non-running Go-Live load path. It does not trigger `/api/go-live/run` and does not build a second readiness evaluator.

Only purchased channels are returned in channel readiness. Facebook and Instagram remain independent channel records even though they share Meta webhook infrastructure.

## Registry service environment

Required on the registry deployment:

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

For every registered client, the registry service receives an environment variable named from the stable client slug. Example:

```text
OPS_CLIENT_TOKEN_BELECO_CLINIC=<same value as Beleco's OPS_READINESS_TOKEN>
```

The registry database stores only the environment-variable name `OPS_CLIENT_TOKEN_BELECO_CLINIC`, never its secret value.

## Automated enrollment during provisioning

New client provisioning can securely pair the client and registry without copying the token through a receipt or terminal output.

Operator shell configuration:

```text
PROVISIONING_OPS_ENROLLMENT_MODE=required
PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID=<central registry Render service ID>
OPS_DATABASE_URL=<dedicated registry postgres>
```

The existing provisioning Render API key is used to write both secret environment variables directly through Render's control plane.

With the full Ops control plane configured, the normal command:

```bash
npm run provision-client -- \
  --client acme-clinic \
  --industry aesthetic_clinic \
  --channels whatsapp,facebook,instagram \
  --runtime-env-file ./acme.client-runtime.env \
  --render-plan starter \
  --execute
```

performs the enrollment flow automatically:

1. generate a fresh 32-byte random token in memory;
2. write it to the client as `OPS_READINESS_TOKEN`;
3. write the same value to the central registry as `OPS_CLIENT_TOKEN_<SLUG>`;
4. let the existing client runtime-finalization deploy apply the client token;
5. deploy the central registry so it loads the matching token;
6. call the client's `/api/ops/readiness` endpoint with the in-memory token and require the exact expected client slug;
7. verify the reported business profile when available;
8. upsert the secret-free registry metadata only after endpoint identity verification succeeds;
9. seed the first successful registry snapshot so the dashboard can show the client immediately.

The token is deliberately non-enumerable in the in-process prepared enrollment object and is never added to command JSON output, the provisioning receipt, the Ops database row, GitHub, or application logs.

Enrollment modes:

- `auto` (default): automatically enroll when both `PROVISIONING_OPS_REGISTRY_RENDER_SERVICE_ID` and `OPS_DATABASE_URL` are configured. With neither value configured, keep the historical standalone provisioning behavior. A partial configuration fails before creating Neon or Render resources.
- `required`: require complete Ops control-plane configuration before any client cloud resource is created. This is recommended for production operators so an untracked client cannot be created accidentally.
- `off`: explicitly skip Ops enrollment.

The mode can be selected with `--ops-enrollment auto|required|off` or `PROVISIONING_OPS_ENROLLMENT_MODE`.

## Recovery and token rotation

If enrollment is interrupted after the client infrastructure exists, do not paste or recover the old token. Re-run enrollment from the secret-free v3 receipt:

```bash
npm run ops:enroll-client -- \
  --receipt .provisioning/acme-clinic.json
```

The recovery command deliberately generates a **new** token, updates both Render services, redeploys the client and registry, verifies the exact client identity, and upserts the same client row. Re-running it is therefore a safe token rotation and registry reconciliation operation rather than a duplicate-client creation path.

The receipt stores only safe recovery state such as:

- token environment-variable name
- client/registry deployment IDs and statuses
- whether each secret environment was configured
- whether the readiness endpoint identity was verified
- whether the registry row was upserted
- verified readiness status and commit SHA
- failure code/stage when enrollment was incomplete

It never stores the token value.

## Manual registration compatibility

The older registration command remains available for existing/legacy deployments and deliberate manual operations:

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

For manual pairing, `npm run ops:generate-token` still generates a suitable secret. Configure that value out of band on both services. Automated provisioning and recovery do not call this command because they keep the generated value in memory and send it directly through the Render API.

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

Version state is intentionally conservative:

- `current` - exact SHA match
- `different` - exact SHA differs
- `unknown` - one side does not expose a commit

Counting exact commits behind `main` is deferred until the registry has an explicit GitHub read integration. Version drift is visibility only and does not block Go-Live.
