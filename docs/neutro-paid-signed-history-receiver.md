# Neutro second-number signed history receiver — rollout gates

**Status: CODE-ONLY PREPARATION. Do not scan the QR yet.**

This implements an optional, **default-OFF** paid Render `/whatsapp/default` bridge for Meta-signed `history` and `smb_app_state_sync` from the independently verified second Neutro WhatsApp Business App number **+60 17-483 1336**. It does not change the existing `/webhook`, Facebook Messenger, any Meta subscription, or the Linkie provider app ownership.

## Receiver properties

- Same paid Render service, raw Meta `X-Hub-Signature-256` HMAC verification at the Express body-parser AND the production-only bridge.
- Identifies the **exact second account and phone ID**, never guesses them, and refuses if they match the existing primary.
- Requires the exact verified sender record `neutro_secondary`, active + Coexistence, through the existing database import staging service.
- Stages passive `history` and `smb_app_state_sync` as durable, sender-qualified jobs before returning HTTP 200. Existing import worker processes them later, asynchronously from the webhook, with replay fingerprints.
- In a mixed batch, attempts durable second-number history storage **before** dispatching any remaining primary/foreign data to the unchanged paid default router. A staging failure returns 503 for a Meta retry, rather than acknowledging and silently losing history. Sender guards and idempotent events prevent cross-account contamination.
- Does not process secondary live messages or echoes as AI turns, open WhatsApp service windows, bill, send templates, or start follow-ups.
- If flag is absent, old QA/bootstrap behavior is unchanged and the production history receiver cannot run.

## DO NOT ENABLE before these proofs

The flags below must not be enabled merely because this PR merges. Enable them in a supervised change only **after** verified Meta authorization, receiver routing and explicit history-sharing consent:

```text
WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED=true
WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED=true
WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED=true
WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=+60174831336
WHATSAPP_PRIMARY_SENDER_KEY=neutro
WHATSAPP_SECONDARY_SENDER_KEY=neutro_secondary
WHATSAPP_SECONDARY_WABA_ID=<actual ID from Meta signup>
WHATSAPP_SECONDARY_PHONE_NUMBER_ID=<actual ID from Meta signup>
WHATSAPP_SECONDARY_EXPECTED_WABA_ID=<same verified actual ID>
WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID=<same verified actual ID>
WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=true
WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=true
WHATSAPP_MULTI_NUMBER_READ_ENABLED=true
WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=true
```

Also requires the existing paid default router to be configured, verified and on, plus the existing primary metadata/account protections. **All secondary outbound, AI, media, templates, follow-ups, billing reservations and one-time history dispatcher remain OFF.**

**Pre-ID limitation:** This strict receiving path starts only *after* the real number's Meta account ID and phone ID have been verified and its secondary sender registered. Do not rely on it to capture a history callback that Meta might send *during* the QR signup before those IDs are available. Before QR approval, independently verify how initial signed history events will be held/retried and that the receiver can be provisioned without losing the one-time transfer. A live signed provider delivery rehearsal is still required; synthetic tests alone are insufficient.

## Test evidence and stop conditions

- Unit: wrong sender/account, absent consent, wrong phone, replay, signature tampering, missing raw-body proof, malformed/mixed batches, DB failure; secondary receipt and billing workers remain independent.
- Real Express HTTP: signed Meta POST accepts only if durable staged; unsigned/tampered refused; storage failure returns HTTP 503; OFF remains OFF.
- Disposable PostgreSQL: database migration 106, exact active sender, duplicate fingerprint=one job, unchanged primary sender and no new live contacts, customer messages, billing or AI jobs. A disabled sender cannot add work.
- Production must be rechecked **read only** after code deployment; no flags, schema, customer records, Meta callbacks or tokens changed in this PR.
- Rollout decision remains **QR NO-GO** until Linkie app's actual Embedded Signup v4 configuration, Meta app-default signed routing, secondary identity lifecycle, and first-history-event timing are independently verified.
