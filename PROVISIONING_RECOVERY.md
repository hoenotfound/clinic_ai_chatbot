# Client provisioning recovery runbook

Use this runbook when `provision-client` stops after a provider/API failure. The provisioning workflow is deliberately non-destructive: it does not delete a Neon project or Render service automatically after a partial success.

The most important rule is:

> **Do not blindly rerun a non-idempotent create step. Inspect the named Render/Neon resources first.**

Resource names are deterministic from the client slug, so the preflight can be used to confirm whether a previous attempt actually created anything.

## `COLLISION_CHECK_FAILED`

Meaning: the provisioner could not reliably confirm that the intended Render and Neon names were unused.

State:

- no Neon create request has been sent by this attempt;
- no Render create request has been sent by this attempt;
- `retrySafe: true` means the preflight itself can be retried after the provider/network issue is resolved.

Action:

1. resolve the Render/Neon API connectivity or permission problem;
2. rerun the dry-run/preflight;
3. only execute after both exact-name checks complete successfully.

## `RESOURCE_NAME_COLLISION`

Meaning: an exact resource already exists, or a concurrent Neon create returned a conflict.

State:

- do not assume the existing resource belongs to a failed attempt;
- do not automatically create a second resource with another name.

Action:

1. inspect the exact resource in Render/Neon;
2. decide whether it is the intended client resource or an unrelated collision;
3. recover/reuse deliberately or remove the unused resource manually before retrying.

## `NEON_CREATE_FAILED`

A Neon project create is non-idempotent. If the underlying provider error is ambiguous, the provisioner reports `retrySafe: false` because Neon may have created the project even though the response never reached the operator.

Action after an ambiguous create failure:

1. **do not immediately rerun `--execute`;**
2. inspect Neon for the deterministic project name shown by the provisioning plan;
3. rerun only after confirming whether that project exists;
4. if it exists, recover from the existing project rather than creating a duplicate.

## `NEON_NOT_READY`

Meaning: Neon returned a project ID, but its create operations did not complete successfully within the expected workflow.

State:

- the Neon project exists;
- the project ID/name are returned in `partialResources`;
- Render has not been created by this attempt yet.

Action:

1. inspect the existing Neon project/operations;
2. recover or wait for that project deliberately;
3. do not create a second Neon project just to continue provisioning.

## `NEON_CONNECTION_URI_FAILED`

Meaning: the Neon project exists and provisioning progressed far enough to request the pooled connection URI, but that URI could not be retrieved.

State:

- the Neon project is preserved;
- Render has not been created by this attempt yet.

Action:

1. inspect the Neon project, database, and role;
2. fix the API/role/database issue;
3. continue from the existing project or deliberately restart only after deciding what to do with it.

## Render create / initial deploy failure after Neon exists

Errors such as `RENDER_CREATE_FAILED`, `RENDER_RESOURCE_COLLISION`, `RENDER_CREATE_RESPONSE_INCOMPLETE`, or `RENDER_DEPLOY_FAILED` can occur after Neon was successfully created.

State:

- Neon is deliberately **not** deleted;
- when Render was created, its service/deploy IDs are returned when known;
- creating another client from scratch can leave duplicate/unused cloud resources.

Action:

1. inspect the preserved Neon project;
2. if a Render service ID/name is present, inspect that same service first;
3. fix the Render configuration/build issue on the existing resources where practical;
4. remove unused resources manually only after deciding they are not recoverable/needed.

## `RENDER_RUNTIME_FINALIZATION_FAILED`

Runtime finalization happens only after the first Render deploy is live and the bootstrap administrator has successfully authenticated. It then:

1. sets `PUBLIC_BASE_URL` to the actual Render URL;
2. removes `ADMIN_PASSWORD` from Render;
3. requests the final Render deploy;
4. waits for that deploy to become live.

A failure can happen between any of those steps. The error contains `partialFinalization` with the state known to have succeeded:

```json
{
  "publicBaseUrlConfigured": true,
  "adminPasswordRemoved": true,
  "deployId": "dep-...",
  "deployStatus": "queued",
  "deployedCommitSha": null
}
```

The provisioning result/receipt preserves this as `runtimeFinalization` with `completed: false` and a non-secret `failureCode`. A successful finalization records `completed: true`. This means receipt-based recovery does not lose the state just because the final readiness step failed.

Treat those fields as the recovery source of truth. For example, if `adminPasswordRemoved` is `true`, do not expect the bootstrap password to still be present in Render environment variables. The administrator itself remains stored in PostgreSQL and the local runtime env file remains the credential source used by `verify-client`.

Action:

1. inspect the **existing** Render service named in the provisioning output/receipt;
2. verify `PUBLIC_BASE_URL` and the current environment state;
3. inspect/retry the existing final deploy if one was requested;
4. once that same service is healthy/live, rerun readiness verification;
5. **do not reprovision Neon and do not create a second Render service.**

## Re-run readiness after infrastructure recovery

If a provisioning receipt exists:

```bash
npm run verify-client -- \
  --receipt .provisioning/<client>.json \
  --runtime-env-file ./<client>.client-runtime.env
```

If provisioning stopped before a receipt could be written, use the recovered Render URL and original client contract directly:

```bash
npm run verify-client -- \
  --url https://<service>.onrender.com \
  --industry home_renovation \
  --channels whatsapp,instagram \
  --runtime-env-file ./<client>.client-runtime.env
```

`verify-client` does not create/delete cloud resources and does not modify chatbot business settings, Pipeline data, or messaging data. It authenticates, runs the protected readiness checks, and reports the current state.

## Readiness state is not provisioning failure

Do not rebuild infrastructure just because readiness says:

- `NEEDS ATTENTION` — health was verified and a required condition is incomplete/unhealthy;
- `VERIFICATION FAILED` — health could not be reliably checked because login/transport/Setup Status failed.

Fix the reported condition and re-run `verify-client` instead.

For purchased channels, final READY evidence is deliberately stricter than the normal Setup Status health card. The latest real inbound customer message must have a later **normal AI reply on the same contact whose exact saved message has provider-acceptance evidence**. System fallbacks, staff replies, scheduled messages, automated follow-ups, promotions, and unrelated successful sends on the same Facebook/Instagram channel cannot satisfy this requirement. A newer failed normal-AI reply attempt blocks readiness until a later exact AI reply succeeds.
