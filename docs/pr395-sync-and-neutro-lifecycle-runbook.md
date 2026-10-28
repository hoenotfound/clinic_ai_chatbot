# PR #395: once-only synchronization, Neutro lifecycle safety and pre-QR gate

**Current decision: NO-GO for QR, Meta callback cutover or production merge.** Code and CI are not proof of real provider routing.

## Isolation and verified identities

- Personal Business App QA number: **privately pinned in Render; do not commit its E.164**. Its phone ID/WABA must be learned from Meta after authenticated onboarding; do not reuse the clinic test number's ID.
- Existing Neutro WABA: `1593376338308612`; Neutro phone ID: `1408739622311791`.
- DA CHATBOT app: `1029862536608134`. Embedded Signup config: `936687052431880`.
- **Updated 28 Oct 2026:** owner verified Meta app-default callback is `https://neutrosense.dasmarketingsolution.com/whatsapp/default` (paid Render), with all 13 fields preserved. Neutro's WABA and phone overrides remain `https://neutrosense.dasmarketingsolution.com/webhook`. This is a previously approved cutover, **not** QR authorization. Do not change either callback during QR; reconfirm current Meta configuration read-only before onboarding. The older `https://clinic-ai-chatbot.onrender.com/webhook` is a rollback candidate, not the current default.
- Dedicated Render staging `srv-dbdgmnks728c73btahcg`: deployed PR #414 branch `pr395-history-handoff-20261028`, auto-deploy OFF. Isolated QA Neon `wandering-dream-82267835`, source `neondb` v104 and destination `pr414_forward_qa` v106. Never touch Neutro production Render/Neon for rehearsals.
- Keep `PR395_STAGING_MODE=true`. All outbound sending/AI/follow-ups/retries remain disabled. `PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED` remains **OFF** during deploy and before owner's later explicit sync approval.
- Pre-signup callback and legacy audit paths are not substitutes for a live signed provider receiver.

## Implementation

- Migration 104 creates `whatsapp_coexistence_sync_dispatch_requests` with unique (WABA,phone,sync_type), validated onboarding attempt, consent provenance, approval time, and receipt status. It also adds durable, staging-only legacy lifecycle alerts.
- Manual service `src/services/pr395CoexistenceSyncDispatcher.js`: refuses production, unpinned/primary identity, unverified approval/consent, expired 24-hour window, missing valid encrypted credential, missing receiver/importer proof or enabled outbound sends.
- **Each sync kind can be reserved exactly once.** The row becomes `dispatching` **before** the POST. A crash/timeout/no response is `unknown`; automatic retry is forbidden. A confirmed Meta `request_id` is retained as a receipt. A definite rejection is retained for human review, not retried.
- `scripts/pr395ManualCoexistenceSync.js` is a separate, manual command. It performs no send unless all readiness parameters, explicit `--execute`, staging environment approval phrase and the independent sync feature gate are supplied. **Do not use it before QR approval and subsequent explicit one-time sync approval.** Do not enable this command in a scheduled job.
- `whatsapp_pr395_legacy_lifecycle_alerts` is populated in the *same transaction* as the signed legacy lifecycle audit. Critical removal/disconnects request operator intervention but NEVER disable or modify the legacy Neutro sender.
- `pr395LegacyLifecycleAlertService` optionally sends Telegram notifications from staging only, with durable pending/processing/sent/unknown status. Unknown Telegram delivery requires manual review to avoid duplicate alert storms.
- IMPORTANT: Meta's app-default callback now points at the paid `/whatsapp/default` router (owner-confirmed 28 Oct). **Genuine Meta-origin lifecycle POST delivery and durable alert audit are still unverified.** Treat this as configuration readiness, not effective production disconnection monitoring. Never assume the draft's isolated staging relay is live.

## Real clinic number preparation — 28 October 2026

**Code-only preparation, NOT live permission or QR readiness.**
The separately approved staging clinic mode is gated by
`PR395_STAGING_REAL_CLINIC_ENABLED=true`,
`PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED=true` and the exact private
`PR395_STAGING_REAL_CLINIC_E164_PIN` corresponding to the intended second
business number. The paid app-default QA audit similarly requires a separate
three-way `WHATSAPP_PAID_REAL_CLINIC_*` approval and phone pin. These flags
must remain OFF in all deployed services until a supervised, identity-verified
rollout is separately approved. Never copy an old personal-QA account, token
or phone ID; get the real WABA and phone ID from authenticated Meta onboarding.

**Updated PR #414 history bridge evidence (28 Oct 2026):** The new
`whatsappSecondaryCaptureHandoff` moves consent-gated AES-GCM encrypted
`history` and `smb_app_state_sync` QA captures to sender-qualified durable
Inbox jobs, and imports them through the passive history worker. It requires
an exact testing source sender and an active, distinct destination sender.
The first real-DB QA rehearsal on paid-branch code passed: 2 encrypted
captured changes, 2 handoffs, 3 original-time Inbox messages, contact
name, media placeholder, replay deduplication, zero billing/sends. Both
QA databases were verified empty of synthetic rows after cleanup, and
the opt-in rehearsal flags were disabled again. GitHub CI also passed.

**Still unproven:** real Meta-origin signed callback delivery for this exact
second WhatsApp Business App identity and the once-only post-onboarding
history request. Neither the staging rehearsal nor CI is permission to
scan QR. The current production paid Render still runs `main` on migration
079. Review, approve and deploy PR #414 to production with all secondary
sending/sync disabled before the QR, and prove the primary still works.
See `docs/pr414-pre-qr-release-gates.md`.

The separate rehearsal branch's local signed HTTP test (synthetic IDs, no
Meta API call) verifies HMAC authentication, AES-GCM encrypted QA storage,
duplicate rejection, consent refusal and unchanged Neutro routing. It does
not prove real signed Meta POST delivery; a separate live-QA database
handoff/import rehearsal now proves the synthetic Inbox transfer.
The real clinic number must not be onboarded on the strength of this test
alone. No Meta callback, production database or existing staging database
is changed by the rehearsal branch.

## Before granting permission to scan the first QR

1. Confirm PR head, all exact-head CI jobs and the new migrations; stage only to isolated Render/Neon, never Neutro.
2. Confirm with read-only Graph that Neutro's primary phone, WABA and both overrides still point to production, and that app-default remains the owner-approved paid `/whatsapp/default` callback.
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
