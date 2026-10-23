# PR #395: Isolated coexistence staging (2026-10-23)

**State:** Prepared as a reproducible runbook; **not deployed and not Meta-onboarded**.
Do not mistake this document or a passing CI job for production approval.

## Ground truth and scope

- Production Neutro Render: `srv-daqd1rp42hec7398itr0`, branch `main`,
  autoDeploy on; it must not be edited, merged into, or have webhooks reassigned
  during staging.
- Production Neon `steep-forest-44509907` `main` remains v077.
- Isolated production-derived Neon QA branch
  `br-steep-flower-b3qayk0r` is v099 (183 historical contacts at last
  check). **Contains real historical customer records.** Protect accordingly.
- Candidate second Business App number: 中医养生馆 / +60 17-483 1336.
  Previously noted phone ID `1318355951360575`; this is a pin requiring
  authoritative Meta token verification, not a permission grant.
- The previous supposed secondary account ID `1071636698738276` is
  **UNVERIFIED**: Meta Graph API returned `(#100) nonexisting field
  (phone_numbers)`. The Meta Messaging Account visible in Business Settings
  is `1852014482431209`. The two IDs are not interchangeable.
- Use a separate URL, credentials, session secret and isolated DB. All other
  WhatsApp numbers, especially Neutro's primary sender, remain unchanged.

## Service provisioning (manual / separate Render service)

Create a **free** Render web service (subject to plan availability),
`da-chatbot-pr395-staging`, from
`hoenotfound/clinic_ai_chatbot` branch
`feature/whatsapp-complete-multinumber-integration-20261022`.
Select Singapore, Node runtime, **Auto-Deploy OFF**,
build `npm ci && npm --prefix portal-frontend ci && npm --prefix portal-frontend run build`,
start `npm start`.
Do not use any production service or main branch for this rehearsal.

Use a dedicated, low-privilege connection to an isolated, access-controlled
database. Prefer **synthetic/sanitized records** rather than attaching the
production-derived QA snapshot to a publicly accessible staging URL. If using
the existing QA branch, protect all portal pages with the PR staging Basic Auth
gate and review access to copied staff accounts before letting anyone log in.

Minimal non-secret configuration:

```dotenv
# Use production-grade Node session and signature security on the QA service.
NODE_ENV=production
# Mandatory sandbox-only guard; does NOT run on main production.
PR395_STAGING_MODE=true
META_APP_ID=1029862536608134
META_GRAPH_API_VERSION=v26.0
WHATSAPP_SECONDARY_SENDER_KEY=tcm_wellness
WHATSAPP_SECONDARY_PHONE_NUMBER_ID=1318355951360575
WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID=1318355951360575
WHATSAPP_SECONDARY_EXPECTED_PHONE_E164=+60174831336
# DO NOT SET WHATSAPP_SECONDARY_WABA_ID from the unverified account ID.
WHATSAPP_COEXISTENCE_ENABLED=false
WHATSAPP_MULTI_NUMBER_READ_ENABLED=false
WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=false
WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=false
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=false
WHATSAPP_SECONDARY_AI_SEND_ENABLED=false
WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false
WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=false
PR395_STAGING_BASIC_AUTH_ENABLED=true
PR395_STAGING_BASIC_AUTH_USERNAME=choose-staging-only-username
# REQUIRED. Exact hostname of the isolated QA Neon DATABASE_URL (not production).
PR395_STAGING_EXPECTED_DATABASE_HOST=ep-<QA-ENDPOINT>.<REGION>.aws.neon.tech
# Never accept provider messages or run background jobs on this sandbox.
PR395_STAGING_ALLOW_PROVIDER_PROCESSING=false
# Generate a staging-only 32+-character random password on your machine.
# PR395_STAGING_BASIC_AUTH_PASSWORD=<store privately in Render>
```

Also configure a **unique 24+-character** staging `SESSION_SECRET`, a unique
`WHATSAPP_VERIFY_TOKEN`, **both** `WHATSAPP_APP_SECRET` and
`META_APP_SECRET` from the owning app (each 24+ characters), and a **QA-only**
`DATABASE_URL` in Render's private environment. App secrets protect the
signature check; do not print them or commit them to Git. The startup will
**refuse to run** if the QA database endpoint does not match
`PR395_STAGING_EXPECTED_DATABASE_HOST` exactly, if Basic Auth is missing,
or if a secondary outbound, inbox, paid receipt, AI or follow-up flag is ON.
Keep all provider subscriptions pointed away from staging until explicitly
rehearsing authorized signed tests.

The sandbox will **not** start existing Neutro workers, outbound retries,
scheduled messages, follow-ups, AI recovery, media pruning, or other background
jobs. POST callbacks are HMAC-checked and then deliberately rejected with HTTP
503 **without processing**; this runbook prepares authorization diagnostics,
not an operational two-number staging environment. Do not configure Meta to
deliver genuine webhook traffic here: Meta would retry 503 callbacks.

**Privacy:** The QA branch contains 183 real customer contacts and copied
staff records. Basic Auth is not a substitute for a sanitized synthetic-data
database; restrict operator access, limit deployment lifetime, and prefer a
fresh empty Neon project for real interactive tests. Never grant staging
access to an external reviewer using the copied user database.

Only for a controlled QR validation session, add the correct DA CHATBOT
`META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`, and validated Meta
permissions to **staging**. The onboarding UI should report `configured`
when all requirements exist. Protect the test route; do not connect production
Meta webhooks yet.

## Account-ID verification before approving QR

1. In Meta Developers confirm DA CHATBOT app ID `1029862536608134`.
2. In Graph API Explorer verify that the management token belongs to this
   app and has `whatsapp_business_management`.
3. From Embedded Signup accept only
   `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` plus its correlated auth code.
   The backend checks token app ID, Meta-owned account inventory and a
   **pinned second-number identity**. Never select first result or use
   Neutro's primary account as a fallback.
4. On Meta error `(#100) nonexisting field (phone_numbers)`, the backend now
   returns `WHATSAPP_COEXISTENCE_ACCOUNT_TYPE_UNVERIFIED` and **does not**
   mark the authorization valid. Determine the actual WhatsApp Account /
   Messaging Account types and their supported Graph edges using the token
   returned for this Embedded Signup. Do not blindly substitute a Messaging
   Account ID for a phone-owning account ID.
5. Compare the returned `display_phone_number` to `+60174831336`;
   compare its phone ID to the pinned ID; verify it is distinct from the
   primary phone ID. Resolve mismatches explicitly before proceeding.
6. Do **not** call `/{phone_id}/register` for Business App coexistence.

## Staging acceptance tests (after controlled authorization)

- Real signed callbacks for both primary and second number, exact account
  and phone IDs; second-number events never trigger Neutro AI/billing.
- Business App echo: staff text + image/video/voice/document/sticker;
  history/contacts and edit/revoke, duplicate WAMIDs, out-of-order receipts.
- Secondary staff/AI/templated outbound with deliberately authorized test
  recipients and billed/nonbillable receipt reconciliation; do **not** infer
  that a 24-hour service window guarantees no charges.
- Simultaneous chats to both business numbers, staff takeover, opt-outs,
  clinically unsafe conversations, delayed callbacks and sender isolation.
- Start with all outbound classes disabled. Only enable the exact class
  after tests and operator billing approval.
- Preserve production Neutro at v077 until a forward-only migration and
  rollback plan is validated. Never run a legacy binary against migrated v099.

**Release:** Keep #395 Draft, no merge, no QR authorization, no callback
subscription changes, and no live sends until staging is accessible, Meta
permissions/account IDs are proven, and signed dual-number tests pass.
The current sandbox mode is intentionally non-operational: a separate sanitized
acceptance environment and controlled provider-routing permission are needed
to perform live signed two-number E2E tests. Do not disable this guard merely
to make an acceptance test pass.
