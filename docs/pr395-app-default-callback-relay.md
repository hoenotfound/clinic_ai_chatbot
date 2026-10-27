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
- A prior Graph review reported a Neutro account using app
  `1029862536608134` and an account-specific override at
  `https://neutrosense.dasmarketingsolution.com/webhook`.
  **Reverify this live by Graph before cutover.** The connected WhatsApp Business
  tool labels `1593376338308612` a *Messaging Account* ID, not a verified
  WhatsApp phone-owning account ID. Never substitute a billing/messaging account
  ID as a WABA identifier merely because past notes used the same label.
  Preserve the existing callback unchanged.
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

The first Coexistence test will use the owner's seldom-used WhatsApp Business App number **<private QA E.164 configured in Render>**, not 中医养生馆. The personal number's Meta Phone Number ID, phone-owning account ID and DA CHATBOT authorization are **unverified**. Do not use the previously observed clinic Phone Number ID `1318355951360575` or account `1852014482431209` for the personal number.

Do not change Meta's app-default callback while preparing this test. A future authorized isolated relay must pin `WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164=<approved QA E.164 set privately, never committed>` and the independently verified personal WABA ID. Its lifecycle target must be a **provider-enabled isolated QA webhook**, not Neutro's production webhook. This is only a proposed routing configuration; no relay service is deployed.

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
  server without this header is treated as failed and retried. Unknown secondary account_update types now fail closed with a retryable 503,
  never reaching an old single-number receiver that could silently ACK them.
- Downstream errors or missing callback overrides return retryable 503;
  invalid HMAC returns 403. The relay has no database, access tokens, AI,
  messaging send permissions or history importer.
- Tests: `node --test test/whatsappAppDefaultRelay.test.js`.
  These are simulated tests and do not establish live Meta compatibility.

## Graph API Explorer results — Linkie Tech portfolio, not DA CHATBOT (27 Oct 2026)

The operator's read-only Meta Graph responses used business portfolio
`1566888928805945`, independently confirmed by the connected business
inventory as **Linkie Tech**, which does **not** grant this connection
administrative visibility into DA CHATBOT Meta App
`1029862536608134`. These are not proof of the DA CHATBOT
app-default callback's complete WhatsApp subscription list:

- `GET /1566888928805945/owned_whatsapp_business_accounts?fields=id,name`
  returned **Test WhatsApp Business Account** ID
  `1612443146941177`, with one record and pagination cursors only.
- `GET /1612443146941177/subscribed_apps` returned
  **chatbot AI2** app `1389129506758387`, overriding to
  `https://da-chatbot-da-chatbot-sales.onrender.com/webhook`,
  and **WA DevX Webhook Events 1P App** `2202427980234937`
  (no override indicated). The target DA CHATBOT App ID
  `1029862536608134` was **absent** from this response.
- `GET /1566888928805945/client_whatsapp_business_accounts?fields=id,name`
  returned **DA Smarketing 2** ID `1529308092292368`.
  The corresponding `GET /1529308092292368/subscribed_apps`
  returned an empty `data` list **under the operator's current token**.
  Do not conflate a subscription read with comprehensive account
  visibility, particularly if Meta asset delegation is incomplete.

**Next required evidence**: In Developer App
`1029862536608134` → Settings → Basic / app owning business,
identify the actual owning business portfolio ID, confirm appropriate
read access on the related WABAs, then repeat owned/client account
inventory for that portfolio and enumerate ALL pages. Check
`GET /{WABA_ID}/subscribed_apps` for *each* account and explicitly
match `whatsapp_business_api_data.id === "1029862536608134"`.
Independently include WABAs held by customers delegated to the app.
Absent matching app subscription in a single portfolio is **not** an
all-portfolio inventory. No routing cutover approved.

## Confirmed portfolio 622200677557573 Graph inventory (27 Oct 2026)

The operator queried these account collections through Graph API v26.0
with an authenticated **DA CHATBOT app-context** user token
(`app_id=1029862536608134`, including `business_management` and
`whatsapp_business_management`):

- `GET /622200677557573/owned_whatsapp_business_accounts?fields=id,name&limit=100`
  returned `{"data":[]}`. **No owned WABAs were visible to this token
  in this specific business portfolio.**
- `GET /622200677557573/client_whatsapp_business_accounts?fields=id,name&limit=100`
  returned **one visible account**: `1593376338308612`
  (`Neutro Sense TCM`). Paging metadata was sanitized in the user
  transcript: cannot assert that all pages were exhausted without
  confirming there is no `paging.next` URL.
- Previously confirmed `GET /1593376338308612/subscribed_apps`
  reports app `1029862536608134` and verified WABA callback
  `https://neutrosense.dasmarketingsolution.com/webhook`.
  Do not change or clear it.

**Important:** zero owned + one client describes this **one business
portfolio under the current token**, not a reverse inventory of all WABAs
subscribed to the DA CHATBOT app across every shared/customer portfolio.
Additionally, an account-specific override protects supported
`messages`/history fields, **not** `account_update`, which remains an
app-default callback event. The bootstrap relay currently forwards
allowlisted old WABA account events to the legacy callback; that route is
**not verified to durably handle Neutro lifecycle updates**. Do not treat
the subscription override alone as proof of cutover safety.

**Next read-only verification:** confirm the client listing has no
`paging.next`, then `GET
/1593376338308612/phone_numbers?fields=id,display_phone_number,webhook_configuration`
to discover any per-number override without touching it. Check the
app's actual subscriptions/tenant assignments outside this portfolio.
Continue **NO-GO** on app-default cutover, PR merge and Coexistence QR
until signed provider and legacy lifecycle acceptance is demonstrated.

## Confirmed Neutro phone-level webhook configuration (27 Oct 2026)

Read-only DA CHATBOT app-context Graph API Explorer v26.0 result for
`GET /1593376338308612/phone_numbers?fields=id,display_phone_number,webhook_configuration`:

- Verified Neutro Meta Phone Number ID: `1408739622311791`.
- Display phone: `+60 11-3053 5053`.
- `webhook_configuration.whatsapp_business_account` =
  `https://neutrosense.dasmarketingsolution.com/webhook`.
- `webhook_configuration.application` =
  `https://clinic-ai-chatbot.onrender.com/webhook`.
- This corroborates `GET /1593376338308612/subscribed_apps` showing
  DA CHATBOT app ID `1029862536608134` with the same account override.
- A paging indicator was sanitized in the shared output, so verify there is
  no additional `paging.next` before asserting only one phone under this
  account. Similarly confirm the owned/client WABA page end before
  claiming the app's complete legacy inventory.

**Critical cutover gate:** the bootstrap relay's current allowlist branch
for a known Neutro WABA forwards ALL fields including `account_update`
to the old legacy webhook. That old production handler is not verified to
commit lifecycle account updates, and a bare HTTP 200 would be a
false-positive acknowledgment. Therefore **do not enter WABA
`1593376338308612` in an active legacy allowlist and change the app
callback without a verified signed, durable legacy lifecycle handler or
a separately verified lifecycle route.** The account-specific override
does not solve application-level lifecycle receipt.

**Current Meta app default URL remains unchanged; relay preparation
mode and provider-facing QA processing remain disabled.** No live
Meta cutover or QR authorization approved.

## Legacy lifecycle durable relay acceptance — coded, NOT enabled

PR #395 now implements an **optional, isolated, audit-only path for a
known legacy account** so `account_update` cannot be silently 200-ACKed by
the old `clinic-ai-chatbot` handler during a future relay evaluation:

- In `WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE=true`, a known account's
  `account_update` changes are split and sent to
  `WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL`, instead of
  `WHATSAPP_DEFAULT_RELAY_LEGACY_URL`. The relay requires
  `X-DA-Legacy-Lifecycle-Accepted: 1` from the audit receiver
  **after a database COMMIT**; bare HTTP 200 causes retryable 503.
  Other known legacy fields continue to their existing legacy callback.
- A second independent protected HMAC route
  `POST /pr395-legacy-lifecycle-webhook` verifies the actual known
  WABA ID and, when the Meta event includes a phone, the separately
  verified Neutro phone number. It writes only sanitized account ID,
  event type, optional phone, entry time, fingerprint, and the default
  `review_required` status. New additive migration **103** adds the
  isolated Neon table `whatsapp_legacy_lifecycle_relay_audit`.
- Bootstrap deliberately supports **one** known legacy WABA until the
  complete app-default account inventory is proven. Multiple IDs fail
  initialization rather than secretly using a single-account audit
  destination for multiple customers. No wildcard route exists.
- The receiver can run alongside the *separate* personal QA
  preidentity audit in staging, but both are **OFF** unless a separate
  approved cutover is being rehearsed. Full synthetic signed HTTP,
  missing-ACK, replay, foreign identity and real PostgreSQL 103 tests
  cover the safe paths. They do **NOT** prove live Meta traffic delivery.

**Never treat this audit as operational disconnect enforcement.**
An incident response workflow must independently suspend Neutro outbound
sending if an actionable disconnect/authorization event occurs. This
review-only audit does not change Neutro's sender configuration, create
Meta subscriptions, send WhatsApp messages, or automatically reactivate a
number. Until a responder and rollback path are verified, real cutover
stays **NO-GO**.

Proposed **private settings for a later operator-approved, isolated
rehearsal ONLY** (do not apply now):

```dotenv
# Protected QA staging, not Neutro:
PR395_STAGING_LEGACY_LIFECYCLE_ENABLED=false
PR395_STAGING_LEGACY_WABA_ID=1593376338308612
PR395_STAGING_LEGACY_PHONE_E164=+601130535053

# Dedicated relay (PREPARATION=true continues to reject all Meta webhooks):
WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true
WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE=false
WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL=https://da-chatbot-pr395-staging.onrender.com/pr395-legacy-lifecycle-webhook
```

Preserve `https://clinic-ai-chatbot.onrender.com/webhook` as Meta's
app-default callback, and preserve Neutro's account override
`https://neutrosense.dasmarketingsolution.com/webhook`.
Do not activate the relay or scan the personal Business App QR before
full account inventory, operational disconnect handling, provider-signed
end-to-end verification and owner approval.

### Meta read-only recheck — 27 Oct 2026

Under DA CHATBOT app context (`app_id=1029862536608134`), an operator
re-ran `GET /622200677557573/client_whatsapp_business_accounts` and
`GET /1593376338308612/phone_numbers`. Visible response data confirms:

- Client business accounts: exactly **one entry shown**, Neutro Sense TCM
  WABA `1593376338308612`. This does **not** establish last page:
  `paging` was sanitized; the absence/presence of `paging.next` was not
  shared.
- Neutro phone `1408739622311791`, display `+60 11-3053 5053`,
  `platform_type=CLOUD_API`, `quality_rating=GREEN`,
  throughput `STANDARD`, `code_verification_status=EXPIRED`.
  This verification-code state alone is **not** proof of inactive sending;
  verify actual service health separately, do not re-register a live number.
- Phone's `webhook_configuration.whatsapp_business_account`:
  `https://neutrosense.dasmarketingsolution.com/webhook`.
  Phone's `webhook_configuration.application`:
  `https://clinic-ai-chatbot.onrender.com/webhook`.

The user has already provided all relevant account and phone IDs, so
**do not request the same queries again**. The remaining inventory question
is whether `paging.next` exists for each response after token-safe redaction;
if present, follow the next page privately in Graph Explorer until absent.
Known Neutro app-default `account_update` remains a lifecycle-cutover risk.
No change to either Meta callback, sender or production service is approved.

## Legacy WABA inventory and live cutover acceptance — not yet complete

**Scope:** enumerate every *phone-owning* WhatsApp Business Account
currently subscribed to Meta Developer App `1029862536608134` (not just
accounts visible through a personal WhatsApp connector, nor Messaging
Accounts for templates/billing). The current connector can see relevant
customer/owner portfolios but **cannot administer or inspect the named DA
CHATBOT Developer App**. Its empty app subscription result therefore
cannot establish that no subscriptions exist.

**Read-only operator workflow in Meta Graph API Explorer (v26.0):**

1. In the Developer App's Settings > Basic, establish its actual owning
   Meta Business portfolio ID. With an authorized Graph token held in
   Explorer *only* (never paste tokens, Graph Explorer URLs with tokens,
   or secrets into PR/GitHub/ChatGPT), enumerate owned and shared WABAs:
   `GET /{BUSINESS_ID}/owned_whatsapp_business_accounts?fields=id,name`
   and `GET /{BUSINESS_ID}/client_whatsapp_business_accounts?fields=id,name`.
   Follow **all paging cursors** and include delegated client accounts
   exposed through the app's integrations. Also inspect Business Settings
   app assignments to make sure delegated users/accounts are not omitted.
2. For each **actual WABA ID**, request
   `GET /{WABA_ID}/subscribed_apps`, check whether app
   `1029862536608134` appears under
   `whatsapp_business_api_data.id`, and record the returned
   `override_callback_uri` (or its absence). For each associated phone,
   inspect `GET /{PHONE_NUMBER_ID}?fields=display_phone_number,webhook_configuration`
   and any more-specific phone callback override.
3. Label the **message/history/sync destination** using the precedence
   phone override > WABA override > app default. Independently label the
   `account_update` destination as the **app-default callback** even if
   the phone/WABA has an override. Mark any unreadable/paginated/missing
   account as **UNVERIFIED**, not "no subscription".
4. Only after every authorized WABA is accounted for, create a complete
   explicit `WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS` allowlist for all
   accounts that may send events to the legacy default. Do not assume
   the known Neutro messaging-account ID is a Graph WABA ID. Require
   an operator-approved account list and a rollback snapshot; never
   allow a wildcard.

**Live acceptance (not yet performed):** first prove the active
standalone relay against **nonproduction signed HTTPS receivers** with
the old app-level Meta callback unchanged; verify TLS, GET challenge,
HMAC, all allowlisted legacy fields, QA exact-E.164 lifecycle, mixed
batches, replay/idempotency, durable acknowledgment, rejected unknowns,
database outage and rollback behavior. Passing local GitHub HTTP tests
alone is not a live Meta acceptance. Before pointing the *real app* to
this relay, obtain explicit operator approval, capture the original
verify token and callback for rollback, verify how every legacy account
behaves for both message and non-overridable account-update fields, and
schedule a monitored short cutover with real signed Meta test/traffic.
Restore the original app-default callback if routing or callbacks are
unconfirmed. Avoid firing synthetic events at the old customer-facing
handler: its deployed code may acknowledge unknown lifecycle types.

**Current GO/NO-GO: NO-GO.** Full developer-app-scoped WABA inventory is
not available through the connected WhatsApp plugin. The relay is still
`WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true`, and staging's
preidentity receiver switch is false. Never set Meta's callback to
the health-only service; it currently rejects every webhook POST.

## Pre-identity lifecycle bootstrap — CODE ONLY, not an active Meta callback

PR #395 now includes an **opt-in bootstrap routing mode** for the short gap
before Embedded Signup returns the new personal-number WABA ID. Existing
`WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true` still overrides everything:
the currently deployed relay remains **inert** (health only, all callbacks 503).

The bootstrap relay uses signed HMAC `account_update` events and sends the
**exact privately pinned personal QA E.164** to
`/pr395-preidentity-webhook` on isolated PR395 staging. An explicit
legacy WABA allowlist is mandatory. It routes only allowlisted legacy
WABA events to the old callback; it refuses all other/ambiguous events
with 503. Unknown account-wide events *without a phone* cannot be
safely attributed before Meta returns WABA ownership and also return 503.
No unknown customer's messages or history are forwarded to Neutro or
acknowledged as saved. Mixed batches need both destinations to succeed;
the legacy receiver must be idempotent across retries.

**Before considering any app-default cutover**, the operator must identify
**every** WABA that currently relies on the legacy app-default callback,
run signed real-provider acceptance with a separately authorized sender,
verify all downstream callback delivery/acknowledgment and review timing
and rollback. Do not assume the currently known Neutro WABA is the only
existing app client (it has an independent override).

Example **private** configuration for a future, separately approved relay
(not to be applied yet; placeholders cannot be used for live routing):

```dotenv
WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=false
WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE=true
WHATSAPP_DEFAULT_RELAY_APP_SECRET=<exact app secret from Meta>
WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN=<fresh private verify token>
WHATSAPP_DEFAULT_RELAY_LEGACY_URL=https://clinic-ai-chatbot.onrender.com/webhook
WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS=<verified full legacy default WABA allowlist CSV>
WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164=<privately verified QA E.164>
WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID=
WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL=https://da-chatbot-pr395-staging.onrender.com/pr395-preidentity-webhook
```

The matching staging receiver must separately have
`PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED=true` under protected
`PR395_STAGING_MODE=true` with zero secondary Meta IDs and all
outbound/provider workers disabled. It verifies exact HMAC against the
Meta app secret, audits only signed candidate WABA ID, business phone,
event type, time and fingerprint in **isolated Neon migration 102**;
its durable HTTP 200 includes
`X-DA-Coexistence-Preidentity-Accepted: 1` only **after DB COMMIT**.
Unknown/mismatched/mixed payloads or SQL failures are 503. Audit rows
are **candidate evidence only**, not authorization to register that WABA
or activate an account.

The isolated HTTP and PostgreSQL tests use synthetic IDs and receivers.
They do **not** validate an active Meta app-default cutover, or eliminate
the need for the actual provider's onboarding events and timing review.
Keep `PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED=false` and
`WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true` on deployed services
until a separately approved live rehearsal. During the signup window,
turning an unknown account-wide Meta event into a 503 retry is the
intentional non-loss policy; verify provider retries in acceptance tests.

## Isolated relay-to-receiver acceptance test

`test/whatsappAppDefaultRelay.integration.test.js` exercises the actual
standalone HTTP relay and two **local loopback** receiver servers with a
strict allowlist. The relay's logical destinations are `.invalid` HTTPS
names, intercepted and mapped to localhost by a test-only fetch dependency.
The QA receiver uses the production lifecycle extraction/persistence
functions but with a **synthetic in-memory SQL-shaped database**, never
Neutro production, isolated Neon or real provider traffic.

Required outcomes: signed mixed batches reach separate mock receivers;
invalid HMAC fails 403; secondary messages, mismatched IDs and unrecognized
secondary account updates cannot leak to legacy; downstream transaction
failure/missing durable ACK is 503; retries are idempotent; legacy downstream
503 does not silently acknowledge a mixed batch; staging sender gate rejects
foreign account/phone metadata. It also runs the preparation-mode server and
shows that `/health/live` alone returns 200 while every webhook GET/POST
is rejected with 503.

This is an **isolated integration simulation**, not a real Meta callback,
provider-authorized sender registration, real Neon durability validation,
or approval for changing the app-default callback.

## Locked standalone Render preparation mode

The standalone entrypoint supports
`WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true` for a pre-onboarding,
inert service. It requires **no Meta secrets, WABA ID or callback targets**;
it never forwards requests, sends messages, or replies to Meta challenges.
Only `GET /health/live` returns 200; all other paths, including
`/webhook`, return 503. Disable auto-deploy and use the PR branch.

Build: `npm ci --omit=dev`
Start: `node scripts/runWhatsAppAppDefaultRelay.js`
Plan: Render Free, region Singapore where available.
Environment: `WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE=true`

A prepared service is NOT an operational relay, and its public URL must
**never** be entered into the Meta app callback settings. To activate routing
later, first independently confirm real secondary WABA ID, app secret and
callback-token continuity, both receiver endpoints, sender-specific
durability and downstream ACK, and obtain a separate cutover approval. Do
not rely on an inert 503 receiver for the 24-hour history import.

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
WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164=<private QA E.164 configured in Render>
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
