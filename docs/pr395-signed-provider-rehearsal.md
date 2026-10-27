# PR #395: controlled signed-provider rehearsal checklist (27 Oct 2026)

**Current decision: CODE PREPARED, INERT IN RENDER. DO NOT SCAN QR OR CHANGE META WEBHOOKS.**

## Ground truth verified read-only

- Render `da-chatbot-pr395-staging` service `srv-dbdgmnks728c73btahcg` is on its own free Render instance, branch `feature/whatsapp-complete-multinumber-integration-20261022`, auto-deploy OFF.
- Independent Neon project `wandering-dream-82267835`, branch `br-late-sky-ao8xggam`, database `neondb`: schema v100, zero contacts, zero registered WhatsApp sender accounts.
- Staging at `e336abd3` was verified live. This runbook's new edits are NOT yet deployed; deploy only after all exact-head CI passes and change review.
- DA CHATBOT Meta app `1029862536608134` has both WhatsApp permissions, and the operator confirmed `messages`, `history`, `smb_app_state_sync`, `smb_message_echoes`, `account_update` are subscribed.
- Neutro's existing messaging account `1593376338308612` is subscribed to DA CHATBOT with override `https://neutrosense.dasmarketingsolution.com/webhook`. Never repoint it.
- The app-default WhatsApp callback points to `https://clinic-ai-chatbot.onrender.com/webhook` (an older binary). The relay introduced in PR #395 is **code only**, not deployed and not ready for a live Meta cutover.
- 中医养生馆 is `+60174831336`, Meta phone ID `1318355951360575`. A candidate phone-owning account `1071636698738276` and distinct messaging account `1852014482431209` were identified. Neither is established as the authorized `entry.id` for DA CHATBOT Embedded Signup. Do not guess `WHATSAPP_SECONDARY_WABA_ID`.

## New test-only guard in this PR

The default protected sandbox remains unchanged, with Meta POSTs returning 503 and all background workers disabled.

A second, opt-in mode `PR395_STAGING_PROVIDER_REHEARSAL_ENABLED=true` is **only eligible** after authorized number/WABA proof. Startup requires:

1. Existing staging Basic Auth and isolated-Neon hostname pin, real HMAC app secret, `NODE_ENV=production`.
2. The exact second account ID pinned in **both** `WHATSAPP_SECONDARY_WABA_ID` and `WHATSAPP_SECONDARY_EXPECTED_WABA_ID`, along with `WHATSAPP_SECONDARY_PHONE_NUMBER_ID=1318355951360575`, `WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID=1318355951360575` and `WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=+60174831336`.
3. A separate authorized secondary token; no live Neutro primary Cloud API token in staging, no sender credential fallback.
4. A valid, exact primary and secondary registry in the **isolated** database, with primary and secondary identities distinct. Staging presently has *zero* sender rows, so this prerequisite is not met. Register only after independent authorization and a reviewed database plan.
5. Sender-scoped read/ingress and strict metadata/account guard enabled, plus `WHATSAPP_COEXISTENCE_ENABLED=true` and `WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=true`.
6. Every staff, AI, media, template, retry, receipt-reconciliation and follow-up outbound switch OFF. The sole background worker permitted in this mode is the passive history/contact importer; `processClaimedBatch` refuses AI execution in any PR395 staging mode.

Only after all six pass should the operator separately enable:
```dotenv
PR395_STAGING_MODE=true
PR395_STAGING_PROVIDER_REHEARSAL_ENABLED=true
PR395_STAGING_ALLOW_PROVIDER_PROCESSING=true
WHATSAPP_MULTI_NUMBER_READ_ENABLED=true
WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=true
WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=true
WHATSAPP_COEXISTENCE_ENABLED=true
WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=true
WHATSAPP_SINGLE_SENDER_STRICT_METADATA=true
WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED=true
WHATSAPP_SECONDARY_SENDER_KEY=tcm_wellness
# Verified account/phone/token settings are prerequisites, never inferred.
```
Do not apply this configuration to existing protected staging today.

The test-only webhook gate runs **after** raw-body HMAC verification and accepts only exact secondary account/phone traffic. Wrong/foreign/mixed traffic and misrouted statuses return 503, not a false 200. Raw incoming customer bodies are not logged by the test gate; if approved in future, consented messages/history can be persisted in the isolated database. AI calls and outbound follow-ups stay off. Basic Auth is not a substitute for signed webhook verification.

## App-default relay validation

Execute automated regression tests against the exact head:
```bash
node --test test/whatsappAppDefaultRelay.test.js
node --test test/whatsappCoexistenceDefaultCallback.test.js
node --test test/whatsappCoexistenceAccountUpdateService.test.js
node --test test/pr395StagingSafety.test.js
node --test test/whatsappCoexistenceHistoryService.test.js
node --test test/whatsappCoexistenceSyncPlan.test.js
```
The relay must verify inbound Meta HMAC, re-sign split deliveries with DA CHATBOT's authorized secret, receive the explicit durable lifecycle ACK from its PR395 downstream, return 503 for upstream failure, and never route secondary customer traffic to the legacy callback.

Before a live Meta default callback change, test the actual relay from a separate isolated service, including other accounts currently dependent on the default callback. No relay service is created by this PR; no real Meta redirect is approved.

## Embedded Signup and history preflight (BEFORE QR)

- Verify owner-administered DA CHATBOT Embedded Signup v4 config `936687052431880` and its real app permissions.
- Verify `whatsapp_business_management` and `whatsapp_business_messaging` with the signup-issued token after the user authorizes the number. **Before QR approval, there is no completed signup token or confirmed callback identity to validate.**
- Confirm the receiver can durably store `history` and `smb_app_state_sync` webhook chunks and its importer runs in staging without launching any AI or follow-up. Do not start history sync against an HTTP 503 receiver.
- If and only if the operator consented to share history, authorized QR onboarding completes and all receivers are live: within 24 hours request `POST /{PHONE_NUMBER_ID}/smb_app_data` separately for `sync_type=history` and `sync_type=smb_app_state_sync`. Each action is one-time and is NOT performed by this PR.
- `src/services/whatsappCoexistenceSyncPlan.js` produces **pure, non-sending** request plans that enforce the 24-hour window, approval and importer prerequisites. Check actual provider request IDs, webhook phases, acceptance, contact count and message import count, with any failure quarantined for staff review. Business App history import covers the **same second number** only, not Neutro's old Cloud API number.

## Blockers and release decision

- Staging's sender registry is empty and its real authorized second WABA/token have not been confirmed. Do not populate guessed IDs.
- The new controlled mode and relay tests require exact-head GitHub CI review and a later protected Render deployment.
- The Meta default callback still targets an old Render service; never cut over without proving all existing tenants' event delivery and downstream lifecycle acceptance.
- Signed end-to-end Meta delivery, history synchronization, opt-out, billing, staff echo and disconnect/reconnect scenarios are not yet tested. No QR scan or app-level webhook change.
- Real Coexistence onboarding is an account change, not a simulated test. Only enable the verified number with explicit user approval and approved business history consent.
- **KEEP PR #395 DRAFT, NEUTRO PRODUCTION UNCHANGED.**
