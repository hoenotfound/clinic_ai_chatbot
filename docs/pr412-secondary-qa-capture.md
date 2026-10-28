# PR #412: isolated WhatsApp Business App secondary QA capture

**PREPARATION ONLY: OFF by default, not QR-ready, not approved for production.**

This PR is stacked on PR #411. It does not run from Neutro's /webhook
or the main /whatsapp/default route. Instead it exposes a separate, signed
and default-disabled /whatsapp/secondary-qa-capture rehearsal endpoint.
The endpoint verifies Meta's raw-body HMAC using the existing webhook parser.
No Meta callback points to this endpoint. No automated sending, AI, Inbox,
template, follow-up, billing, contact-import worker or Graph API calls.

For each authorized and verified secondary field:
- Require exact independent secondary business account and phone ID.
- Require explicit human approval, verified processing consent, and separately
  verified consent for history and contact sync.
- Require QA Neon host pinning, independent encryption key, QA migration
  identities 102–104, and a QA-only sender row in testing state.
- Limit a signed request to 100 changes and each encrypted event to 2 MB;
  digest for deduplication, encrypt with AES-256-GCM, and commit to QA Neon
  before acknowledging a rehearsal request with HTTP 200.
- Capture only messages, smb_message_echoes, history and smb_app_state_sync.
  This is a staging ledger, NOT actual chat history import or AI operation.
- No raw payload, token or key is printed in logs. Sensitive staging rows
  have a required expiry timestamp (default 24h, maximum 72h).

## Not a production schema migration

The SQL artifact `ops/qa-only/001_secondary_encrypted_capture.sql`
is *not* under `src/db/migrations` and must NEVER be run against Neutro.
An operator must separately approve execution on the verified isolated
QA Neon project ONLY. This request does not execute the SQL.

Expiry timestamps do NOT automatically remove data in PostgreSQL. The QA
capture gate remains disabled until a verified retention/purge procedure
exists. The QA-only pruning SQL is provided as a comment in that file,
but is **not executed automatically**.

## Meta webhook field verification

Read-only script: `node scripts/qa/readOnlyMetaWebhooks.cjs`.
It checks the developer app's WhatsApp object callback, whether fields
`messages`, `account_update`, `history`, `smb_app_state_sync`,
`smb_message_echoes` are subscribed, plus Neutro's existing account-level
override and app subscription. It uses only GET requests and never writes
to Meta. Required environment input, kept private:
`META_APP_ID`, `WHATSAPP_WABA_ID`, `META_APP_ACCESS_TOKEN`,
`META_READ_ONLY_MANAGEMENT_TOKEN`, `META_EXPECTED_NEUTRO_CALLBACK`,
optional `META_GRAPH_API_VERSION` (defaults v26.0).

A passing script is NOT approval for callback changes or QR. It cannot
inspect a phone-number-level callback override, verify whether a current
subscription is published or prove live signed delivery. These need
separate Meta checks. The connected Neutro business view currently does
not expose an administered developer app; do not claim live fields are
confirmed from these docs or from the local test output.

Public documentation describes the field types and why account_update
and template-management webhooks can still arrive at the app default
even when Neutro has an account-specific override. Never replace the
existing app default callback until these events are handled explicitly.

## Deliberately missing before secondary go-live

1. Real account identity and phone ID after authorized Coexistence onboarding,
   verified actual app-specific field subscription and signed delivery.
2. Tested privacy/retention, encryption-key custody, QA table DDL and
   bounded worker that imports history passively rather than triggering AI.
3. Durable secondary customer inbound, status and echo handling with explicit
   sender-specific metadata, delivery states and contact uniqueness.
4. Manual one-shot history/contact sync consent and authorization within
   Meta's onboarding window (never inferred from QR alone).
5. Real production migration reconciliation from
   `docs/pr395-production-migration-reconciliation.md`, and a new
   rollback candidate after production migrations >079.
6. Full capacity and resource verification on the paid 512 MB Render service.

**Until then:** keep PRs #395, #411 and #412 draft; leave flags OFF, do not
merge, deploy, switch Meta callbacks, send secondary messages or scan QR.
