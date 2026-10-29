# Neutro second number: first-history-event safety (pre-QR)

**CODE ONLY. ALL FLAGS OFF. QR STILL NO-GO.**

This adds a minimal, encrypted pre-identity history/contact hold to the **existing paid** `/whatsapp/default` endpoint. It is **not** an authorization shortcut or an extra Render service. The rest of Neutro's existing WhatsApp `/webhook` and Facebook Messenger `/meta-webhook` are unchanged.

## Why
Some Coexistence webhook documentation describes `history` and `smb_app_state_sync` callbacks arriving in the first minutes after Embedded Signup, before an operator has registered the Meta-issued phone ID. PR #425 correctly refuses unverified identities but could miss those early events. A separate once-only manual `smb_app_data` request is **not** sufficient to guarantee that automatically delivered events are preserved.

## Pre-identity receiver (strictly short-lived)
The existing Meta app-default endpoint optionally captures only `history` and `smb_app_state_sync` when:
- Raw Meta `X-Hub-Signature-256` HMAC validates.
- `metadata.display_phone_number` exactly normalizes to the intended **+60 17-483 1336**.
- Numeric Meta WABA and phone IDs are present and distinct from the primary IDs.
- Provider app secret matches the existing production app secret; expected primary ID, distinct secondary key, and a **separate production 32-byte encryption vault key** are available.
- Both operator and data owner separately approve **temporary encrypted receipt of unverified historical customer data before QR**.
- There is an explicit time-limited capture window of no more than 24 hours and no secondary sending, AI, billing or follow-up flags are enabled.

Enable only after full live webhook routing and owner's privacy consent have been reviewed:
```
WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED=true
WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED=true
WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED=true
WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL=<future UTC ISO 8601 timestamp, within 24h>
WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED=true
WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED=true
WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=+60174831336
WHATSAPP_SECONDARY_SENDER_KEY=neutro_secondary
```
These are **rollout values, not instructions to enable now**. Preserve the original primary sender and app-default secrets. Do not expose key values.

Signed events are encrypted using AES-256-GCM with a context-isolated key derived from the existing production vault key. They remain unverified and never enter contacts, Inbox messages, AI, Meta sends, templates or billing. Unique digests prevent replay duplicates. A PostgreSQL transaction commits every held event before HTTP 200. Unattributed foreign history returns a retryable error, not a silent ACK. A partial or failed DB write returns 503. Hold records expire logically at 48 hours; run the cleanup command to physically erase expired ciphertext. The receiver also cleans up expired records during accepted capture.

## After verified QR
1. Verify Meta's actual authenticated `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` result, exact E.164, phone-owning WABA, phone ID, `is_on_biz_app` and Coexistence state. Require explicit history/contacts consent.
2. Register the exact `neutro_secondary` sender, active and coexistence_enabled, with no outbound capability. Enable PR #425's strict history receiver after its signed-routing rehearsal and operator approval.
3. Separately approve **manual** handoff: `WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED=true`. This additionally requires all PR #425 receiver gates and a saved verified signup/credential record.
4. Run `node scripts/neutroEarlyHistoryHandoff.js` **without flags** for metadata-only dry-run. After reviewing it, use `--execute --confirm=VERIFIED_NEUTRO_SECONDARY_ONLY` in a supervised paid Render shell.
5. Each held change is decrypted **only after** authenticated WABA/phone/owner and registered sender match. The existing importer stores every child job, verifies fingerprints, then deletes the encrypted hold in **one PostgreSQL transaction**. Duplicate handoffs, crashes and retry attempts remain safe.
6. Independently verify importer drain, history/contact integrity, no primary customer mutations, no AI or sending. A separate manual Meta history/contact sync needs its own irreversible approval and must be inside Meta's documented window.

## Stop and rollback
- **Do not start QR** until current Meta subscriptions, signed actual provider deliveries, primary+Messenger health, runtime capacity, schema 107 on a disposable PostgreSQL replica and pre-ID callback timing are verified.
- Wrong phone/WABA, absent display number, missing approval, expired capture window, database or encryption failure: stop and investigate, do not assume a Meta retry will save one-time history.
- To stop new capture, set `WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED=false` in a supervised Render deployment; never change primary WhatsApp or Messenger settings.
- After 48 hours and explicit cleanup approval, set `WHATSAPP_PAID_SECONDARY_EARLY_PURGE_OPERATOR_APPROVED=true` and run `node scripts/neutroEarlyHistoryHandoff.js --purge-expired`. This is required to physically erase unused expired holds. No automatic cron or extra database compute is added.
- The first real history event might still take a different route or lack the expected metadata. **Synthetic CI and this code are not sufficient proof of live Meta delivery.** QR remains NO-GO until a supervised live signed delivery rehearsal and fallback plan pass.

Migration `107_whatsapp_secondary_early_history_hold.sql` is new and additive; previously applied migrations remain immutable. It is **not yet deployed**. Do not merge or deploy without a separately approved controlled production change.
