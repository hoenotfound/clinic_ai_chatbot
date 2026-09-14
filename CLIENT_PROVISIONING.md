# Client provisioning and readiness

This repository provides an internal operator workflow for one isolated client deployment:

```text
one client
  -> one Render web service
  -> one Neon project/database
  -> one dedicated private R2 bucket when automated R2 is enabled
  -> one explicit industry profile
  -> one explicit purchased-channel contract
  -> optional/required Ops Registry enrollment
  -> production readiness verification
```

Provisioning is dry-run by default and mutates providers only when `--execute` is supplied. Partial infrastructure is preserved for recovery rather than deleted automatically.

## Provisioning flow

`provision-client` validates the client/profile/channel contract, checks deterministic Render/Neon/R2 names for collisions, creates Neon, optionally creates a dedicated R2 bucket and bucket-scoped client access, injects the generated R2 runtime values into Render, deploys the client, finalizes its runtime, performs Ops enrollment when enabled, verifies readiness, and writes a secret-free receipt v4.

Supported canonical industries are `aesthetic_clinic`, `home_renovation`, and `generic`. Supported purchased channels are `whatsapp`, `facebook`, and `instagram`. Only purchased channels block go-live.

## Automated R2 modes

Use:

```text
--r2-provisioning auto|required|off
```

- `auto` is the default. It enables automated R2 when the complete Cloudflare control-plane setup is available; otherwise it preserves the manual-R2 path. Partial setup fails closed.
- `required` requires automated R2 before cloud creation and is the preferred production mode once adopted.
- `off` disables automated R2 and keeps manual runtime R2 configuration.

When automated R2 is enabled, client-supplied R2 runtime overrides are rejected because the provisioner owns those values. The operator-side Cloudflare setup stays on the operator side and is never copied into the client service.

Each automated client receives a deterministic private bucket and access scoped only to that bucket.

### R2 location and recovery identity

The configured Cloudflare R2 location is a best-effort placement hint, not a durable identity guarantee. Recovery therefore does not reject the exact deterministic bucket merely because Cloudflare reports a different actual location.

When Cloudflare reports bucket jurisdiction, recovery requires it to match the plan. Durable R2 recovery identity is based on the account, deterministic bucket name, jurisdiction, and exact bucket scope.

## Ops Registry enrollment

Ops enrollment continues to support `auto|required|off`. If enrollment needs repair after provisioning, run:

```bash
npm run ops:enroll-client -- --receipt .provisioning/<client>.json
```

The Ops enrollment and registration tools accept receipt versions 3 and 4.

## Dry-run example

```bash
npm run provision-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --render-plan starter \
  --runtime-env-file ./acme.client-runtime.env \
  --r2-provisioning required \
  --ops-enrollment required
```

The dry run performs no cloud mutation. Review the deterministic resources, R2 mode, profile, channels, and Render plan before executing. Add `--execute` only after the plan is correct. Add `--json` for machine-readable output.

## Exit codes

```text
0 = dry run, READY, or READY WITH WARNINGS
2 = validation/provisioning failure before a usable deployment exists
3 = infrastructure live; verification completed; NEEDS ATTENTION
4 = infrastructure live; readiness verification could not complete
5 = infrastructure live; enabled Ops Registry enrollment is incomplete
```

Do not recreate infrastructure merely because readiness returns 3, 4, or Ops enrollment returns 5.

## Readiness and exact channel proof

A purchased channel becomes round-trip ready only after a real customer inbound is stored and a later normal AI reply on the same contact has exact provider-acceptance evidence, with no newer failed normal-AI reply and healthy ordinary messaging runtime.

Staff replies, scheduled messages, follow-ups, promotions, fallbacks, and unrelated sends do not satisfy the final go-live proof.

## Receipt v4

Provisioning writes `.provisioning/<client-slug>.json` after infrastructure is live. Receipt v4 contains only recovery/readiness metadata and adds secret-free R2 state: mode/status, bucket name, generated access identifier/name, location hint, and jurisdiction.

R2 receipt fields are explicitly allowlisted so generated runtime access values cannot be serialized accidentally. Older receipt v3 remains supported by the Ops recovery and registration tools.

## Interrupted automated-R2 recovery

Do not blindly rerun normal creation after partial success. Deterministic collision protection is expected to stop duplicates.

Use:

```bash
npm run recover-client -- \
  --client acme-cabinets \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

Review the dry-run plan, then add `--execute`.

Recovery adopts only the exact deterministic Neon/R2/Render resources. It validates R2 jurisdiction and exact bucket scope. When Render returns the relevant metadata, recovery also validates repository, branch, service type, and region before adopting an existing service.

See `PROVISIONING_RECOVERY.md` for the detailed recovery runbook.

## Re-run readiness without reprovisioning

With a receipt:

```bash
npm run verify-client -- \
  --receipt .provisioning/acme-cabinets.json \
  --runtime-env-file ./acme.client-runtime.env
```

Without a receipt, provide the deployed client URL together with the expected industry, purchased channels, and the same runtime input file.

`verify-client` does not create or delete cloud resources and does not mutate chatbot business settings, Pipeline data, or messaging data.
