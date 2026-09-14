# Client provisioning recovery runbook

Use this runbook when `provision-client` stops after a provider or network failure. Provisioning is deliberately non-destructive: partial Neon, R2, and Render resources are preserved for inspection and recovery.

> **Do not blindly rerun a non-idempotent create step. Recover the deterministic resources first.**

## Readiness failures are not provisioning failures

Do not rebuild infrastructure merely because readiness reports `NEEDS ATTENTION` or `VERIFICATION FAILED`. Fix the reported health/test condition and rerun `verify-client`.

Use infrastructure recovery when provisioning stopped during Neon, R2, Render creation, initial deployment, or runtime finalization.

## Automated-R2 interrupted-run recovery

For an interrupted automated-R2 run, use:

```bash
npm run recover-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

The command is dry-run by default. Review the deterministic Neon project, R2 bucket/token, and Render service, then repeat with `--execute` when the plan is correct.

Recovery uses the same operator-side provider configuration as normal provisioning. It never copies operator control-plane credentials into the client service.

Recovery is fail-closed and non-destructive. It:

1. requires exactly one deterministic Neon project;
2. discovers the active Neon branch, database, and owner role;
3. reuses the exact deterministic R2 bucket or creates it only when confirmed absent;
4. treats the original Cloudflare location hint as best effort, so a different actual bucket location does not block recovery;
5. validates bucket jurisdiction when Cloudflare returns it;
6. finds the deterministic Cloudflare token by exact name;
7. before rolling a token value, requires the token to be active and restricted to exactly the expected bucket and bucket-item permission;
8. fails on duplicate active tokens, unexpected scope, inactive tokens, jurisdiction mismatch, or ambiguous provider resources;
9. validates an existing Render service's repository, branch, service type, and region when those fields are available;
10. updates only the managed R2 runtime values on an existing Render service, or creates the exact Render service if it never existed;
11. continues normal runtime finalization and readiness verification;
12. writes a secret-free provisioning receipt v4.

After infrastructure recovery, Ops Registry enrollment can be repaired with:

```bash
npm run ops:enroll-client -- --receipt .provisioning/acme-cabinets.json
```

The Ops repair path accepts both receipt v3 and v4.

## Collision and partial-create errors

`COLLISION_CHECK_FAILED` means provider lookups could not prove the intended names were unused. Resolve the provider/network issue and retry the preflight.

`RESOURCE_NAME_COLLISION` means an exact deterministic Render, Neon, or R2 resource already exists. If it belongs to the intended interrupted run, use `recover-client`; do not create a differently named replacement.

`NEON_CREATE_FAILED`, `NEON_NOT_READY`, and `NEON_CONNECTION_URI_FAILED` may leave the deterministic Neon project in place. Inspect that project and recover it rather than creating a duplicate.

Automated-R2 failures such as `R2_RESOURCE_COLLISION`, `R2_BUCKET_CREATE_FAILED`, and `R2_CREDENTIAL_CREATE_FAILED` preserve known safe identifiers for recovery. Do not blindly repeat an ambiguous token-create request. `recover-client` searches for the deterministic token, validates its exact scope, and rolls it when safe. If no same-name token exists, it may create the deterministic bucket-scoped token.

Cloudflare's `locationHint` is not used as bucket identity. A different actual location is acceptable; an explicit jurisdiction mismatch still fails closed.

Render errors such as `RENDER_CREATE_FAILED`, `RENDER_RESOURCE_COLLISION`, `RENDER_CREATE_RESPONSE_INCOMPLETE`, and `RENDER_DEPLOY_FAILED` can occur after Neon and R2 already exist. For automated-R2 deployments, use `recover-client` so the existing resources are validated and reused safely.

## Runtime finalization failures

`RENDER_RUNTIME_FINALIZATION_FAILED` can occur after the first deployment is live. The receipt preserves the known finalization state, including whether the public URL was configured, whether bootstrap credentials were removed, and any accepted final deployment identifier/status.

Inspect and repair the existing Render service. Do not reprovision Neon or R2 solely because finalization or readiness failed.

## Re-run readiness after recovery

With a receipt:

```bash
npm run verify-client -- \
  --receipt .provisioning/<client>.json \
  --runtime-env-file ./<client>.client-runtime.env
```

Without a receipt:

```bash
npm run verify-client -- \
  --url https://<service>.onrender.com \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./<client>.client-runtime.env
```

`verify-client` does not create/delete cloud resources or mutate chatbot business, Pipeline, or messaging data.

For purchased channels, READY requires a real customer inbound followed by a later normal AI reply on the same contact with exact provider-acceptance evidence. Staff replies, scheduled messages, follow-ups, promotions, fallbacks, and unrelated sends do not satisfy that proof.
