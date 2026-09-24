# Staged client provisioning

Staged provisioning is for confirmed clients whose Render/Neon/R2 environment
should be created before messaging-channel credentials are available.

It is intentionally opt-in. Normal `--execute` remains strict and still requires
all purchased-channel runtime credentials before cloud resources are created.

## Command

Add `--defer-channel-readiness` to the normal provisioning command:

```bash
npm run provision-client -- \
  --client neutro-sense-tcm \
  --industry tcm_clinic \
  --channels whatsapp,facebook,instagram \
  --runtime-env-file ./neutro-sense-tcm.client-runtime.env \
  --ops-enrollment required \
  --defer-channel-readiness \
  --execute
```

The client runtime file may leave purchased-channel credentials blank while the
client is still granting access. Do not use fake IDs or fake tokens.

## What staged provisioning still requires

Staged mode does not weaken infrastructure or core application validation. The
runtime preflight still requires:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- at least one supported AI credential
- the R2 runtime contract, supplied automatically when managed R2 provisioning is enabled
- all normal Render, Neon, R2, and Ops control-plane configuration

The provisioner still creates the normal isolated resources, verifies the admin
login, finalizes `PUBLIC_BASE_URL`, removes the bootstrap `ADMIN_PASSWORD`
from Render, enrolls the client in the Ops Registry, and runs Setup Status.

## What is deferred

Only purchased messaging-channel readiness is deferred. Missing or not-yet-live
signals for WhatsApp, Facebook Messenger, or Instagram can remain pending.

Examples include:

- missing WhatsApp phone/token configuration
- missing Facebook Page/token configuration
- missing Instagram Page/token configuration
- pending Messenger/Instagram webhook evidence
- no real inbound message yet
- no provider-accepted AI reply yet

Core failures are never treated as staged success. Database, migration, security,
public URL, admin account, AI, R2, business-profile, and other non-channel
readiness failures still make the command exit non-zero.

## Output and receipt

A successful staged run prints:

```text
Execution mode:  staged (channel readiness deferred)

Staged onboarding
Status:         INFRASTRUCTURE READY; CHANNELS PENDING
```

The secret-free provisioning receipt records:

- `channelReadinessDeferred: true`
- a `stagedReadiness` summary containing only blocker keys/counts, never tokens

The normal full readiness report remains in the receipt so the pending channel
state is visible and auditable.

## Finishing the client later

When the client's real messaging assets are available:

1. Put the real channel IDs/tokens into the local client runtime file.
2. Apply those values to the existing client Render service. Do not reprovision.
3. Complete Meta asset authorization/subscriptions.
4. Register Facebook/Instagram routing identities with
   `npm run meta-router:register-client`.
5. Configure the WhatsApp WABA callback with
   `npm run whatsapp-webhook:configure`.
6. Run `npm run verify-client` using the existing provisioning receipt.
7. Send real inbound messages on every purchased channel and confirm the
   provider-accepted AI replies.

The client is not go-live ready until the normal verifier reports READY or READY
WITH WARNINGS.

## Safety rule

Use staged provisioning only for a confirmed client. It creates billable cloud
resources before the messaging channels are live.
