# PR #395: controlled signed-provider rehearsal checklist (27 Oct 2026)

**Current decision: CODE PREPARED, INERT IN RENDER. DO NOT SCAN QR OR CHANGE META WEBHOOKS.**

## Ground truth verified read-only

- Render `da-chatbot-pr395-staging` service `srv-dbdgmnks728c73btahcg` is on its own free Render instance, branch `feature/whatsapp-complete-multinumber-integration-20261022`, auto-deploy OFF.
- Independent Neon project `wandering-dream-82267835`, branch `br-late-sky-ao8xggam`, database `neondb`: schema v100, zero contacts, zero registered WhatsApp sender accounts.
- Staging at `f6739c97` was verified live in protected mode. These later PR edits are NOT yet deployed; deploy only after all exact-head CI passes and change review.
- DA CHATBOT Meta app `1029862536608134` has both WhatsApp permissions, and the operator confirmed `messages`, `history`, `smb_app_state_sync`, `smb_message_echoes`, `account_update` are subscribed.
- Neutro's existing messaging account `1593376338308612` is subscribed to DA CHATBOT with override `https://neutrosense.dasmarketingsolution.com/webhook`. Never repoint it.
- The app-default WhatsApp callback points to `https://clinic-ai-chatbot.onrender.com/webhook` (an older binary). The relay introduced in PR #395 is **code only**, not deployed and not ready for a live Meta cutover.
- 中医养生馆 is `+60174831336`, Meta phone ID `1318355951360575`. A candidate phone-owning account `1071636698738276` and distinct messaging account `1852014482431209` were identified. Neither is established as the authorized `entry.id` for DA CHATBOT Embedded Signup. Do not guess `WHATSAPP_SECONDARY_WABA_ID`.

## 27 Oct 2026 — first Coexistence test switched to personal account

- **First live test candidate:** owner's low-traffic WhatsApp Business App number. Its full E.164 must be supplied privately through Render; do not commit personal phone numbers to the public repository.
- **Original proposed clinic test:** 中医养生馆 **+60174831336**, Meta Phone Number ID **1318355951360575**. This number is now explicitly **rejected** by the isolated provider rehearsal guard; its existing WhatsApp Business App and Cloud API state must remain untouched.
- The new personal number's **Meta Phone Number ID and WABA/account ID have NOT been independently verified**. These IDs are not derivable from its E.164 digits. Do not use the old clinic Phone Number ID, a synthetic test ID, or guesses.
- The staging Render service still has its existing **protected, provider-disabled configuration**. It must not be enabled until the operator verifies real account ownership, subscribes DA CHATBOT with the account-specific callback override, configures the correct credentials and registers only this verified QA sender in isolated Neon.
- Staging **QA sender key** is now `coexistence_qa`. Never configure the original `tcm_wellness` identity for the personal-number test. This sender key does not authorize reusing Neutro business details, AI, templates or follow-ups.
- Synthetic IDs like `290000000000002` in unit tests are **fixtures only**, not a Meta account or phone ID. Staging must fail closed if the verified new IDs are absent.

## Business App-only first test: Meta ID discovery (no QR yet)

The personal QA number currently exists only in the WhatsApp Business App.
Meta can create/return a WABA ID during Embedded Signup and return the Phone Number ID
in the session or through the authenticated `/{verified_waba_id}/phone_numbers`
Graph edge afterward. There is no legitimate pre-signup Meta phone ID to
copy from the Business App settings. Do NOT invent one or borrow the clinic ID.

**Before signup:** Use protected staging (not provider rehearsal), set the
independently verified personal QA E.164 privately in BOTH
`WHATSAPP_SECONDARY_EXPECTED_PHONE_E164` and
`PR395_STAGING_APPROVED_TEST_PHONE_E164`; keep
`WHATSAPP_SECONDARY_PHONE_NUMBER_ID`,
`WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID`, and
`WHATSAPP_SECONDARY_WABA_ID` empty. The sender key is `coexistence_qa`.
`PR395_STAGING_APP_ONLY_SIGNUP_READY=false` (default) keeps the
Connect action **disabled** until a human operator has verified webhook,
history-import readiness, authorization-only mode, and the rollback plan.
Only then may the operator set it to `true` with explicit consent for the
real account onboarding. Enabling this flag alone NEVER permits provider
webhooks or outbound AI.

**After Meta FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING:** The backend exchanges
the one-time code, validates the app-scoped access token, verifies the
WABA and its phone edge, checks the returned E.164 against the private pin,
and rejects the Neutro primary and excluded clinic phone IDs. It records
the verified IDs in the isolated onboarding audit but does NOT automatically
register the Business App number, change the production callback, enable
provider processing, or install sender runtime credentials. Review the
returned IDs and account ownership separately, then stage exact sender rows
before enabling any receiver. Normal `/{phone_id}/register` is not used
for this Coexistence path.

**Important:** The QR scan / in-app connection is a real account action,
not an ID-only preview. The backend cannot obtain its final signup-issued
IDs without the owner's approved account action. Do not start onboarding
while history and callback handling still return 503. Prepare this path and
all downstream acceptance checks first, including the app-default lifecycle relay.

## 27 October 2026 — secure Embedded Signup system-user token handoff

Before PR #395, Embedded Signup exchanged and verified the short-lived code
but discarded the resulting **60-day system-user access token**. The new
optional service callback captures that token **server-side only**, after
validating the business account/phone, app ID and both WhatsApp permission
scopes. The staging route refuses to consume the authorization code unless
the dedicated credential encryption key is configured and checked.

Migration `101_whatsapp_coexistence_encrypted_credentials.sql` adds an
isolated credential table keyed by validated onboarding attempt. The route
writes both the validation audit and AES-256-GCM ciphertext in **one database
transaction**. The 12-byte random nonce and authentication tag are stored
with ciphertext. AEAD associated data binds the encrypted token to the exact
onboarding attempt, WABA ID and Meta Phone Number ID. Failed encryption,
expired/missing token expiry or failed SQL means **no validated onboarding**.

Generate a unique 32-byte base64 secret using your private administrator
terminal: `openssl rand -base64 32`. Set it through Render's **private**
environment settings as `PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY` on
`da-chatbot-pr395-staging` only. NEVER commit or share its value, and never
reuse an app secret/verify token/session secret. Keep this value stable while
any test number is authorized: rotating it without rewrapping or deleting
the old ciphertext prevents subsequent authorized token retrieval.

The vault's internal `loadValidatedCredentialForSetup({wabaId,
phoneNumberId})` requires **both** independently verified sender IDs,
checks token expiry and decrypts only on the private staging service.
This is a **server-side setup handoff**, not a new API endpoint or automatic
send, registration, subscription, broadcast, marketing, or history sync.
The client response continues to contain identifiers, token expiry and an
activation-required status, **never an access token**. PR395 staging remains
guarded: `PR395_STAGING_APP_ONLY_SIGNUP_READY=false`, provider rehearsal off,
all AI/outbound/follow-ups off. No real phone authorization is implied.

The key, expiry, sender-binding, fail-closed SQL write and real PostgreSQL
tests must pass exact-head CI before staging deployment. A later authorized
setup flow must still use the stored token to perform explicit WABA
subscription/callback verification and one-time consented sync; don't scan
the QR until that operational stage has been rehearsed.

**App-level callback:** Leave Meta's default
`https://clinic-ai-chatbot.onrender.com/webhook` unchanged. The standalone
relay is currently health-only, 503 on every webhook; never set it as the
Meta callback in preparation mode. Neutro's account-specific override stays
unchanged.

## Real-provider activation runbook (strict staged go/no-go)

**Status on 27 Oct 2026: NOT approved for owner QR scan.** The personal
WhatsApp Business App number is pre-pinned privately in staging but has NOT
been connected to DA CHATBOT. Its Meta WABA ID and Phone Number ID are still
unknown and **must never** be replaced with a guess or the previous clinic
ID. Isolated QA Neon schema 101 has no senders/onboarding/sync jobs.
The relay is publicly deployed but is in **preparation-only** mode: only
`GET /health/live` responds with HTTP 200; webhook delivery returns 503.
The current app-default callback is still
`https://clinic-ai-chatbot.onrender.com/webhook`.

The **read-only** safety model
`src/services/pr395CoexistenceActivationReadiness.js` and its tests require
**independently observed evidence**, not mere passed unit tests, before
any real signup or one-time sync. It never invokes Graph, modifies Render,
changes a callback, stores credentials, or sends messages.

### Gate A — before the personal Business App QR

1. Preserve Neutro's separate WABA callback override and all existing
   production messages. Snapshot Meta app-level callback, subscribed fields,
   authorized businesses and which accounts depend on the legacy default.
2. Provide a verified, signed app-default lifecycle route before onboarding.
   `account_update` **cannot** use a per-WABA override. The current
   health-only Render relay cannot handle any of these events. The existing
   app-default must either be made safe for the new QA lifecycle or, only
   after a full regression/forwarding trial for every current tenant, be
   switched to a fully configured relay. Do NOT point Meta at the inert URL.
3. Rehearse a safe *pre-identity* event holding/response policy because Meta
   may create the WABA ID only during Embedded Signup. It must not ACK and
   silently discard a new QA account's lifecycle, contact or history events.
   An unrecognized event must remain recoverable without delivering it to
   an unrelated client's chatbot. Keep signed raw-body HMAC verification.
4. Show staging can accept signed QR-issued secondary callbacks **after
   authorization** with a bounded transition: exact WABA+phone pin, primary
   credential rejection, isolated sender registry, durable `history` and
   `smb_app_state_sync` queue inserts, importer drain, duplicate replay,
   disconnection suspend, and 503 on DB outage. Staging is intentionally
   returning 503 today and is NOT yet a production-ready receiver.
5. Confirm the owner's history-sharing preference. Back up the Business App
   chats and obtain explicit consent to connect **only** the personal QA
   number. Keep all staff/AI/media/template/follow-up/billing outbound off.
6. Confirm the v4 Embedded Signup config `936687052431880`, both WhatsApp
   scopes, the subscribed fields `messages`, `history`,
   `smb_app_state_sync`, `smb_message_echoes`, and `account_update`,
   private AES-GCM key, and owner-qualified QA E.164.

### Gate B — immediately after explicit owner-approved QR onboarding

1. A successful `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` supplies Meta's
   WABA and phone identity. The server verifies exact phone ownership using
   the **signup-issued secondary token**, checks required scopes, and
   atomically stores only AES-GCM encrypted credential + validation audit.
   Check the Meta phone status `is_on_biz_app=true`,
   `platform_type=CLOUD_API`. NEVER invoke ordinary
   `/{phone_id}/register` for Business App Coexistence.
2. With the actual Meta IDs, pin ONLY the isolated QA secondary in Render and
   Neon. Prepare a sender-specific, **inbound-only** receiver: ensure all
   existing primary-sender credentials are inert and every outbound flag is
   false. Enable the passive importer only after a signed webhook
   acceptance/replay test and verified WABA account-specific override.
3. Subscribe DA CHATBOT to this new WABA and configure/verify its
   **account-specific** callback URL
   `https://da-chatbot-pr395-staging.onrender.com/webhook`
   using the verified secondary token. A successful GET challenge alone
   is not proof: confirm `/{WABA_ID}/subscribed_apps` reports DA CHATBOT
   and the exact override. Do **not** edit the current app-default
   callback or Neutro WABA override.
4. Prove a real Meta-signed `messages` or `smb_message_echoes` event
   reaches ONLY the QA receiver and is stored durably (no AI). Confirm
   `account_update` routing separately using the proven app-default
   lifecycle handler. Missing or wrong account/phone, signature or database
   failure must not be ACKed as valid customer work.

### Gate C — one-time consented SMB data sync, under 24 hours

1. Reconfirm the exact verified secondary Meta IDs and decrypt the
   sender-bound unexpired token server-side. Confirm the account-specific
   override, durable inbound 200 behavior, importer running and no previous
   `smb_app_data` requests for this sender. Record the business owner's
   consent and onboarding completion timestamp. If a request already
   succeeded or its provider outcome is unknown, **DO NOT retry**.
2. Use `prepareCoexistenceSyncPlan()` only to generate a **non-sending**
   preview after all gates pass. The one-time contacts call is
   `POST /{verified_phone_number_id}/smb_app_data` with JSON
   `{"messaging_product":"whatsapp","sync_type":"smb_app_state_sync"}`.
   Only with explicit owner *history* consent, separately send
   `{"messaging_product":"whatsapp","sync_type":"history"}` to the SAME
   phone-number endpoint. These are independent, one-time requests.
3. Persist Meta's `request_id`, HTTP outcome, time and sync type in the
   separate QA audit before declaring completion. Do not send blind
   retries on timeouts or unknown responses. Monitor `smb_app_state_sync`
   and `history` webhook phases/chunks, job acknowledgments and worker
   failures; history opt-out/error `2593109` means no history transfer.
   Do not confuse API acceptance with completed import. A progress
   marker and stored import counts are needed to prove completion.
4. Check that imported history is passive, sender-isolated, cannot create
   a live 24-hour customer service window, AI job, follow-up, outbound
   billing reservation or marketing consent. Verify actual QA contacts/
   imported rows and zero Neutro production changes.
5. For a missing webhook or partial import, preserve the request ID and
   investigate with Meta instead of repeating a one-time request. Suspend
   QA provider ingress on disconnection, wrong sender or unverified routing.

**Current limits:** the code implements encrypted credential handoff,
read-only sender mapping, a pure sync planner, webhook staging, importer and
a safe preparation relay. It does NOT yet implement an operator-approved
live sync dispatcher with a persisted once-only request ledger, an
automated safe default-callback cutover, or pre-identity webhook buffering.
Do not interpret this document or passing CI as proof those missing live
capabilities have been activated. These must be completed/reviewed before
the QR and any real sync.

## New test-only guard in this PR

The default protected sandbox remains unchanged, with Meta POSTs returning 503 and all background workers disabled. The staging variables are not automatically updated by changing this PR; do not enable provider flags while they still refer to the old clinic phone.

A second, opt-in mode `PR395_STAGING_PROVIDER_REHEARSAL_ENABLED=true` is **only eligible** after authorized number/WABA proof. Startup requires:

1. Existing staging Basic Auth and isolated-Neon hostname pin, real HMAC app secret, `NODE_ENV=production`.
2. The verified **personal QA** account ID pinned in both `WHATSAPP_SECONDARY_WABA_ID` and `WHATSAPP_SECONDARY_EXPECTED_WABA_ID`. The two phone ID variables (`WHATSAPP_SECONDARY_PHONE_NUMBER_ID`, `WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID`) must contain the **same real Meta Phone Number ID** for <private QA E.164 configured in Render>, obtained through authorized Meta onboarding/asset inspection. Also configure `WHATSAPP_SECONDARY_EXPECTED_PHONE_E164` and `PR395_STAGING_APPROVED_TEST_PHONE_E164` to the same independently approved E.164 using private Render environment variables. **The actual Meta IDs are still unknown.**
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
WHATSAPP_SECONDARY_SENDER_KEY=coexistence_qa
WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=<approved private QA E.164>
PR395_STAGING_APPROVED_TEST_PHONE_E164=<same approved private QA E.164>
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
- The app-only phone-ID discovery guard, personal QA safeguard and relay tests require exact-head GitHub CI review and a later protected Render deployment. Before provider activation, separately verify and apply both new Meta IDs to Render (maintaining the isolated Neon pin).
- The Meta default callback still targets an old Render service; never cut over without proving all existing tenants' event delivery and downstream lifecycle acceptance.
- Signed end-to-end Meta delivery, history synchronization, opt-out, billing, staff echo and disconnect/reconnect scenarios are not yet tested. No QR scan or app-level webhook change.
- Real Coexistence onboarding is an account change, not a simulated test. Only enable the verified number with explicit user approval and approved business history consent.
- **KEEP PR #395 DRAFT, NEUTRO PRODUCTION UNCHANGED.**
