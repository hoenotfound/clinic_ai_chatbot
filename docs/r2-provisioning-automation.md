# Automated R2 provisioning

This work extends the existing one-Render + one-Neon-per-client provisioning model with a dedicated private Cloudflare R2 bucket and bucket-scoped S3 credentials per client.

## Target flow

```text
provision-client
  -> validate the complete control plane before cloud creation
  -> check Render, Neon, and R2 resource-name collisions
  -> create Neon
  -> create a dedicated private R2 bucket
  -> create an account-owned Cloudflare API token scoped only to that bucket
  -> derive R2 S3 credentials from the one-time token value
  -> create Render with DATABASE_URL + R2 credentials in the initial environment
  -> finish the existing Render/Ops/readiness flow
```

No R2 control-plane credential or generated client secret may be written to the provisioning receipt, stdout JSON, normal logs, the Ops database, or source control.

## Cloudflare control-plane configuration

The operator creates one Cloudflare control token manually and keeps it only in the local/operator environment:

```env
PROVISIONING_CLOUDFLARE_ACCOUNT_ID=...
PROVISIONING_CLOUDFLARE_API_TOKEN=...
PROVISIONING_R2_MODE=required
PROVISIONING_CLOUDFLARE_R2_LOCATION_HINT=apac
```

The control token needs the Cloudflare permissions required to:

- create/list R2 buckets (`Workers R2 Storage Write`)
- create/roll account-owned API tokens (`Account API Tokens Write`)

It is a provisioning credential. It must never be copied into a client Render service.

## Provisioning modes

The R2 provisioning module supports the same gradual-rollout idea as Ops enrollment:

- `auto` (default): automate R2 when both Cloudflare control values are present. If neither is configured, preserve the current manual-R2 path. Partial configuration fails closed.
- `required`: require complete Cloudflare control configuration. This is the intended production mode once the integration is complete.
- `off`: deliberately skip Cloudflare R2 provisioning and preserve manual R2 runtime credentials.

## Resource naming

For a normal client resource such as:

```text
da-chatbot-acme-renovation
```

the dedicated R2 bucket is:

```text
da-chatbot-acme-renovation-media
```

Bucket names are normalized and capped at Cloudflare's 63-character limit.

The generated account-owned token uses a safe operator-facing name such as:

```text
da-chatbot-acme-renovation-r2
```

## Client credential scope

The generated client token is restricted to the exact bucket resource:

```text
com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<BUCKET_NAME>
```

with the bucket-scoped permission:

```text
Workers R2 Storage Bucket Item Write
```

That permission lets the chatbot read, write, and list objects in its own bucket without granting bucket-management access to the client runtime.

The provisioning module resolves the permission-group ID from Cloudflare at runtime rather than relying on a hardcoded permission identifier.

## S3 credential derivation

Cloudflare's R2 authentication contract for API-created tokens is:

```text
R2_ACCESS_KEY_ID     = created token ID
R2_SECRET_ACCESS_KEY = SHA-256(created token value)
```

The raw one-time token value is never returned from the provisioning client. It is converted immediately to the S3 secret access key.

The resulting client runtime variables are:

```env
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
```

## Recovery

Cloudflare supports rolling an account-owned token value while preserving its policy. The module exposes that primitive so a later recovery command can regenerate the one-time value and derive a new R2 secret without widening the token's bucket scope.

The production integration should keep the existing no-destructive-auto-rollback policy. If Neon/R2/Render creation stops partway through, preserve safe resource identifiers for inspection and recovery rather than deleting resources automatically.

## PR #129 implementation stages

1. Cloudflare R2 provisioning client, plan/mode validation, token derivation and tests.
2. Integrate R2 planning into `provision-client` dry-run and deterministic preflight.
3. Add Render environment injection and collision-safe R2 creation to the main provisioning transaction.
4. Add secret-free receipt/recovery metadata and an R2 repair/rotation command.
5. Add end-to-end mocked provisioning tests plus production rollout guidance.

Do not merge the feature until the full integration is complete and CI is green.
