# PR #395: once-only synchronization, Neutro lifecycle safety and pre-QR gate

**Current decision: NO-GO for QR, Meta callback cutover or production merge.** Code and CI are not proof of real provider routing.

## Isolation and verified identities

- Personal Business App QA number: **privately pinned in Render; do not commit its E.164**. Its phone ID/WABA must be learned from Meta after authenticated onboarding; do not reuse the clinic test number's ID.
- Existing Neutro WABA: `1593376338308612`; Neutro phone ID: `1408739622311791`.
- DA CHATBOT app: `1029862536608134`. Embedded Signup config: `936687052431880`.
- **Never change app-default** `https://clinic-ai-chatbot.onrender.com/webhook` without separate approval. Neutro's account override stays `https://neutrosense.dasmarketingsolution.com/webhook`.
- Dedicated Render staging `srv-dbdgmnks728c73btahcg`: branch is PR #395, auto-deploy OFF. Isolated Neon `wandering-dream-82267835`. Confirm staging's actual connection, flags and fresh deployed commit before testing. Do not touch Neutro production Render/Neon.
- Keep `PR395_STAGING_MODE=true`. All outbound sending/AI/follow-ups/retries remain disabled. `PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED` remains **OFF** during deploy and before owner's later explicit sync approval.
- Pre-signup callback and legacy audit paths are not substitutes for a live signed provider receiver.

## Implementation

- Migration 104 creates `whatsapp_coexistence_sync_dispatch_requests` with unique (WABA,phone,sync_type), validated onboarding attempt, consent provenance, approval time, and receipt status. It also adds durable, staging-only legacy lifecycle alerts.
- Manual service `src/services/pr395CoexistenceSyncDispatcher.js`: refuses production, unpinned/primary identity, unverified approval/consent, expired 24-hour window, missing valid encrypted credential, missing receiver/importer proof or enabled outbound sends.
- **Each sync kind can be reserved exactly once.** The row becomes `dispatching` **before** the POST. A crash/timeout/no response is `unknown`; automatic retry is forbidden. A confirmed Meta `request_id` is retained as a receipt. A definite rejection is retained for human review, not retried.
- `scripts/pr395ManualCoexistenceSync.js` is a separate, manual command. It performs no send unless all readiness parameters, explicit `--execute`, staging environment approval phrase and the independent sync feature gate are supplied. **Do not use it before QR approval and subsequent explicit one-time sync approval.** Do not enable this command in a scheduled job.
- `whatsapp_pr395_legacy_lifecycle_alerts` is populated in the *same transaction* as the signed legacy lifecycle audit. Critical removal/disconnects request operator intervention but NEVER disable or modify the legacy Neutro sender.
- `pr395LegacyLifecycleAlertService` optionally sends Telegram notifications from staging only, with durable pending/processing/sent/unknown status. Unknown Telegram delivery requires manual review to avoid duplicate alert storms.
- IMPORTANT: because Meta's app-default callback is **still** the old service, **real Neutro `account_update` events are not yet proven to reach the new durable alert audit**. Until the relay and signed legacy delivery are independently verified, this is code readiness, **not effective production disconnection monitoring**.

## Before granting permission to scan the first QR

1. Confirm PR head, all exact-head CI jobs and the new migrations; stage only to isolated Render/Neon, never Neutro.
2. Confirm with read-only Graph that Neutro's primary phone, WABA and account-specific webhook override still point to production. Confirm the app-default callback is unchanged.
3. Map every legacy WABA actually subscribed to app `1029862536608134` (complete pagination and delegated portfolios). Do not claim the one portfolio inventory is comprehensive.
4. Independently rehearse the separate relay with signed realistic events: mixed Neutro/secondary batches, correct HMAC, strict routing, Neutro lifecycle durable commit and required acknowledgment headers, timeout and replay handling.
5. Verify the owner personal Business App E.164 pin stored privately in staging. Confirm no old `tcm_wellness`/Ariel credentials, clinic phone ID or guessed account ID are reused. Pin new IDs **only when verified by the actual Meta signup**.
6. Ensure provider-capable isolated inbound processing, durable importer, DB schema and monitoring work *before* signup. The existing authorization-only sandbox intentionally returns 503 to provider messages and is not by itself sufficient.
7. Confirm the operator is available to check Neutro production live throughout the test, with clear stop criteria and a restore plan that **does not roll back production schema or casually overwrite Meta callback settings**.
8. Ensure written owner approval explicitly covers the QR and recognizes potential WhatsApp Business App synchronization changes. QR approval does not automatically grant history sharing, real message sending, or paid billing approval.

## Immediately after a separately approved QR

1. Verify real Meta WABA and phone-number ownership and the privately pinned QA E.164 exact match. If mismatch, **stop**.
2. Check `is_on_biz_app`, `platform_type`, WABA app subscription and account callback override using signed provider evidence. Check Neutro phone/webhook again. If it changes, **stop** and investigate without modifying production.
3. Test a signed benign inbound/echo to the QA receiver with AI/staff outbound still disabled; verify only the correct sender and QA database rows are touched.
4. Record verifiable user choice about contacts and history separately. A history opt-out must never be silently turned into consent.
5. If and only if the importer and callback are proven and the owner separately approves one-time sync, enable the narrow isolated sync gate and execute each approved request once during the 24-hour window. Inspect the ledger **before** pressing execute. A `dispatching` or `unknown` result is a hard stop, not a retry candidate.
6. Compare Meta `request_id`, signed chunk arrivals, import progress and audit rows. Do not convert historical messages into new 24-hour customer windows or AI triggers.
7. Continue watching Neutro and QA for disconnection or webhook routing anomalies. Disable only QA sending/processing as safe intervention; avoid Neutro account changes without separate approval.

## Read-only operator queries against **isolated staging Neon only**

```sql
SELECT waba_id,phone_number_id,sync_type,state,http_status,
       provider_request_id,request_started_at,updated_at
FROM whatsapp_coexistence_sync_dispatch_requests
ORDER BY id DESC;
SELECT account_id,event_type,severity,delivery_state,updated_at
FROM whatsapp_pr395_legacy_lifecycle_alerts
ORDER BY updated_at DESC;
SELECT account_id,event_type,handling_status,recorded_at
FROM whatsapp_legacy_lifecycle_relay_audit
ORDER BY recorded_at DESC LIMIT 30;
```

**STOP conditions:** uncertain sync response, wrong Meta identity, any primary webhook change, incomplete HMAC/legacy acknowledgment, missing history consent, unknown charges, unexpected secondary sends, Neutro inbound/outbound interruption or unacknowledged critical lifecycle alert.

**Explicitly prohibited without additional operator approval:** scanning QR, changing Meta app-default callback, modifying Neutro overrides/prod service/DB, activating new outbound sending, merging PR #395.
