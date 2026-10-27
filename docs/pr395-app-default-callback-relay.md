# PR #395: DA CHATBOT app-default WhatsApp webhook safety

**Status: CODE ONLY, NOT DEPLOYED, NOT AUTHORIZED FOR META CUTOVER.**
This plan is intentionally separate from existing Neutro messaging. The standalone
relay is not imported by `src/createApp.js`, not used by `npm start`, and
does not change any currently configured Meta subscriptions or callbacks.

## Verified evidence (27 October 2026)

- Developer app `1029862536608134` has approved `whatsapp_business_management`
  and renewed `whatsapp_business_messaging`.
- The user confirmed subscriptions for `messages`, `history`,
  `smb_app_state_sync`, `smb_message_echoes`, `account_update`.
- Existing Neutro WhatsApp Messaging Account `1593376338308612` returned
  app ID `1029862536608134` and account-specific override
  `https://neutrosense.dasmarketingsolution.com/webhook`.
  Keep this callback **unchanged**.
- Meta WhatsApp app-default callback shown in the dashboard is
  `https://clinic-ai-chatbot.onrender.com/webhook`. Render resolves that
  hostname to the separate older `clinic_ai_chatbot` service, deployed from
  a pre-PR395 commit, without the new disconnect safety handler.
- Second-number account `1852014482431209` responded
  `{"data":[]}` to `/subscribed_apps` under the tested token. That
  is not evidence of completed Embedded Signup or sender authorization.
  Number +60 17-483 1336 has Phone ID `1318355951360575`.
  **Do not infer the authorized WABA / event `entry.id` from this ID.**

Meta's app-default callback receives `account_update`, even when a
WhatsApp account has a callback override. A separate solution is required
because deploying PR #395 to Neutro production alone would leave Meta's
app-default events pointed at the older service.

## Current controlled QA target (27 October 2026)

The first Coexistence test will use the owner's seldom-used WhatsApp Business App number **+60187004870**, not 中医养生馆. The personal number's Meta Phone Number ID, phone-owning account ID and DA CHATBOT authorization are **unverified**. Do not use the previously observed clinic Phone Number ID `1318355951360575` or account `1852014482431209` for the personal number.

Do not change Meta's app-default callback while preparing this test. A future authorized isolated relay must pin `WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164=+60187004870` and the independently verified personal WABA ID. Its lifecycle target must be a **provider-enabled isolated QA webhook**, not Neutro's production webhook. This is only a proposed routing configuration; no relay service is deployed.

## Implementation included in PR #395

`src/services/whatsappAppDefaultRelay.js` is a standalone Node server with
`scripts/runWhatsAppAppDefaultRelay.js` as its **separate** entrypoint.

- Check the raw Meta HMAC before parsing or forwarding.
- Verify the approved secondary WhatsApp account ID and E.164 for
  `account_update` events; send these to a provider-enabled PR #395
  lifecycle handler. Do not send secondary message/history/echo payloads
  to the legacy callback.
- Preserve other existing app-default WhatsApp events by forwarding them
  to the original `clinic-ai-chatbot` callback. For mixed batches,
  split by change and sign each subset with the same authorized Meta
  app secret. Both downstream handlers must tolerate Meta retry.
- A lifecycle 200 must include `X-DA-Coexistence-Lifecycle-Accepted: 1`,
  set only after PR #395 durably handles the event. A 200 from an older
  server without this header is treated as failed and retried. Unknown
  secondary account_update types preserve legacy routing; only recognized
  disconnection and reconnection events use the lifecycle handler.
- Downstream errors or missing callback overrides return retryable 503;
  invalid HMAC returns 403. The relay has no database, access tokens, AI,
  messaging send permissions or history importer.
- Tests: `node --test test/whatsappAppDefaultRelay.test.js`.
  These are simulated tests and do not establish live Meta compatibility.

## Candidate isolated Render service (NOT CREATED)

Use a new, separate service only **after** full design approval and a rehearsal.
Do not replace an existing Render service, run the relay via ordinary
`npm start`, or point Meta to staging `da-chatbot-pr395-staging`:
that sandbox intentionally rejects provider traffic with HTTP 503.

Build command: `npm ci --omit=dev`

Start command: `node scripts/runWhatsAppAppDefaultRelay.js`

Required environment variables, populated privately in Render (never commit
secrets or put credentials in command arguments):

```dotenv
PORT=10000
WHATSAPP_DEFAULT_RELAY_APP_SECRET=<Meta DA CHATBOT app secret>
WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN=<existing DA CHATBOT WhatsApp callback verify token>
WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID=<validated WABA from v4 Embedded Signup, never guessed>
WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164=+60187004870
WHATSAPP_DEFAULT_RELAY_LEGACY_URL=https://clinic-ai-chatbot.onrender.com/webhook
WHATSAPP_DEFAULT_RELAY_LIFECYCLE_URL=<isolated-provider-enabled-qa-https-webhook>
```

The lifecycle target must be a separate authorized, **provider-enabled**
acceptance handler when testing. It must run PR #395, validate the same
DA CHATBOT signature, verify the exact second sender account and phone, and
durably persist a signed suspension before responding 200. Do not point
the relay at the currently provider-disabled sandbox or an old main binary.
A new Render service may incur charges; request owner approval first.

## Must-pass acceptance BEFORE changing the Meta app-default URL

1. Confirm every other existing WhatsApp account relying on the app-default
   endpoint. Relay its account-level event to the old callback and prove
   equivalent behavior. Test mixed primary + secondary events.
2. Confirm correct same-app-secret HMAC acceptance by **both** downstream
   services and strict 403/503 behavior for signature/DB outages, including an
   old server returning 200 without the durable lifecycle marker.
3. Verify the new, consented secondary Embedded Signup v4 account identity
   and pin the real webhook WABA ID. Do not call `/{phone_id}/register`
   on an app-Coexistence phone.
4. Prove provider-enabled sender-specific history, echoes, media, customer
   inbound, statuses, and signed `PARTNER_REMOVED` / `ACCOUNT_OFFBOARDED`
   / `ACCOUNT_RECONNECTED` acceptance. Do not scan a production QR before
   the history receiver is ready.
5. Simulate lifecycle downstream outage (must return 503) and Meta duplicate
   retries (must be idempotent). Validate Neutro's own account override and
   active replies remain intact.
6. Have an operator approve the cross-service privacy boundary, service
   costs, maintenance/monitoring, allowed accounts, and callback-change
   window. Retain an outage runbook and observe metrics during rollout.

**Only then**, with explicit authorization, switch the Meta App's default
WhatsApp topic callback from the old `clinic-ai-chatbot` service to the
dedicated relay. Preserve Neutro's account-level callback override.

Rollback must **first stop secondary outbound/follow-ups** if the secondary
lifecycle events would otherwise be silently acknowledged by the old default
callback; do not treat restoration of the old URL as a complete safe rollback
while Coexistence sends remain enabled. Disable only the second sender;
Neutro must remain operational.

## Remaining blockers

- Correct second WABA and DA CHATBOT token/subscription not yet verified.
- No dedicated provider-enabled two-number testing endpoint exists.
- No actual signed Meta coexistence, history, delivery, billing and
  disconnect acceptance has passed.
- No approval to create additional billed infrastructure, to scan the
  second-number QR, or to change any live Meta callback.
- Production Neutro currently runs old schema 077 and PR #395 is Draft.
  Do not merge solely because GitHub CI passes.
