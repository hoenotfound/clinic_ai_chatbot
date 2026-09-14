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
- create/list/read/roll account-owned API tokens (`Account API Tokens Write`)

It is a provisioning credential. It must never be copied into a client Render service.

## Provisioning modes

The R2 provisioning module supports the same gradual-rollout idea as Ops enrollment:

- `auto` (default): automate R2 when both Cloudflare control values are present. If neither is configured, preserve the current manual-R2 path. Partial configuration fails closed.
- `required`: require complete Cloudflare control configuration. This is the intended production mode once automated R2 is adopted.
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

The generated account-owned token uses a deterministic operator-facing name such as:

```text
da-chatbot-acme-renovation-r2
```

The deterministic names are also the recovery identity. Recovery never adopts a differently named bucket or token.

## Location hint versus jurisdiction

`PROVISIONING_CLOUDFLARE_R2_LOCATION_HINT` is passed to Cloudflare when the bucket is created, but it is a best-effort placement hint rather than an ownership or recovery invariant. Recovery therefore does **not** reject an existing deterministic bucket merely because Cloudflare reports an actual location different from the requested hint.

Recovery does validate the bucket jurisdiction when Cloudflare returns one. The default provisioning model expects the `default` jurisdiction. Account + deterministic bucket name + jurisdiction + exact token scope form the durable recovery identity.

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

## Receipts

New provisioning writes receipt version 4. Receipt v4 adds only secret-free R2 recovery metadata:

- R2 mode/enabled/provisioned state
- bucket name
- token ID and deterministic token name
- location hint and jurisdiction

The receipt builder uses an explicit R2 allowlist. Even if a future in-memory result accidentally contains `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, or a raw token value, those fields are not serialized into the receipt.

Existing Ops tools accept both receipt v3 and v4 so older clients remain repairable while new R2-enabled clients can use the same Ops enrollment/re-registration workflows.

## Interrupted provisioning recovery

Provisioning remains deliberately non-destructive. A failure after Neon/R2/Render creation does not delete provider resources automatically.

Use the dedicated recovery command for an interrupted automated-R2 run:

```bash
npm run recover-client -- \
  --client acme-renovation \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./acme.client-runtime.env
```

Review the dry-run first, then add `--execute`.

Recovery uses the same deterministic resource names as the original provisioning run and follows these rules:

1. Exactly one matching Neon project must exist. Recovery discovers its active main branch, database and owner role, then requests a fresh pooled connection URI.
2. If the exact R2 bucket exists, it is reused. If the exact bucket is confirmed absent, recovery may create that exact bucket. It never adopts a differently named bucket.
3. A different provider-reported R2 location is allowed because the original location hint is best effort; an explicit bucket-jurisdiction mismatch fails closed.
4. If a same-name Cloudflare token exists, recovery validates that it is active and has exactly one allow policy, exactly one resource equal to the expected bucket, and exactly the expected bucket-item permission before rolling its value.
5. Multiple same-name active tokens, unexpected token scope, inactive tokens, jurisdiction mismatch, or ambiguous provider resources fail closed. Recovery does not widen permissions or silently choose one.
6. If no same-name token exists, recovery creates the deterministic bucket-scoped token and derives new S3 credentials in memory.
7. If the exact Render service already exists, its repository, branch, type and region are checked when the provider returns them. Recovery updates only the managed R2 environment values and redeploys the existing service. It does not restore the bootstrap admin password or replace unrelated runtime variables.
8. If the Render service does not exist, recovery creates it with the recovered Neon database and R2 credentials, then continues normal login/finalization/readiness checks.

After recovery writes the normal secret-free v4 receipt, Ops enrollment can be repaired with:

```bash
npm run ops:enroll-client -- --receipt .provisioning/acme-renovation.json
```

The recovery command never prints or writes the database URL, generated R2 secret, raw Cloudflare token value, or client runtime secrets.

## PR #129 implementation stages

1. Cloudflare R2 provisioning client, plan/mode validation, token derivation and tests. Completed.
2. Integrate R2 planning into `provision-client` dry-run and deterministic preflight. Completed.
3. Add Render environment injection and collision-safe R2 creation to the main provisioning transaction. Completed.
4. Add secret-free v4 receipt metadata, v3/v4 Ops compatibility, and safe interrupted-run recovery/rotation. Completed.
5. Complete final regression review, CI, and production rollout validation before merging.

Do not merge the feature until final review and CI are green.
