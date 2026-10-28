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

## Operational Meta notification review (read-only, not automated)

PR #411 now saves subscribed **Neutro-only** account, security, phone-quality,
template and calling notifications as sanitized, idempotent QA audit rows.
There is no automatic staff notification, ticketing integration, template
approval update, call processing or acknowledgement state. The receipt
HTTP 200 only confirms persistence of audit metadata.

PR #412 includes:
`node scripts/qa/readOnlyOperationalWebhookQueue.cjs`.

Run it manually with the same verified independent QA Neon connection settings
as PR #411: `DATABASE_URL`, `WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL`,
`WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST`, and Neutro's
`WHATSAPP_WABA_ID`. It rejects production/QA host collisions, performs
a single bounded, parameterized SQL **SELECT** over the last 24 hours,
and prints a sanitized list with operator action suggestions.
Security/account alerts exit with code 3, so a human can spot urgent entries.
Missing data/connection reports an error rather than claiming safety.
**Do not use this as a scheduled alert** until operator access, escalation
ownership and a regular checking cadence are separately configured.

Records currently share QA's `whatsapp_sender_quarantined_events` table with
`reason=unsupported_whatsapp_event` (meaning the chatbot did not act on
the notification). Their severity is a conservative *field-based triage*
and does not mean the underlying Meta event was a confirmed compromise.
The source table has no operator acknowledgement state, so repeat queries
may show previously reviewed entries. To investigate a field such as
`message_template_status_update`, use the authorized Meta dashboard; no
notification payload or customer message content is available in the QA
audit table.

The read-only QA inventory query found zero records for these fields in the
last seven days on 2026-10-28. This is expected before deploying the new
ingress, **not** proof of successful live Meta delivery.

## CI-only migration rehearsal and remaining production-copy gate

The added `test/neutroV079DisposablePostgresRehearsal.test.js` runs only
when `TEST_DATABASE_URL` points to **localhost or 127.0.0.1**. On GitHub CI's
disposable PostgreSQL 16 service, it creates an isolated synthetic database,
executes the actual migration runner through v077, applies unchanged sales
migrations 078 and 079, verifies the resulting schema/checksums, confirms
a v079-aware runner starts without new migration work, and confirms v077-only
code refuses the newer history. The test drops its CI database afterward.
It does **not** connect to Neon and does not contain patient data.

This is a fresh-schema compatibility rehearsal, not yet a restored-production
regression test: real historic rows, foreign key anomalies, production indexes,
Neon pooled connection behavior and a full old application restart need a
separately authorized disposable *restored production* database and a verified
backup before approving a live deployment.

## Migration rehearsal still awaiting a separately authorized disposable DB

PR #411's CI pins a v079-compatible rollback **source tree**, but has not
booted that tree against a restored database. Before deployment:
- Verify a non-production restored copy of v077 with realistic schema;
- Apply only unchanged main 078 and 079 migrations there;
- Start the proposed v079 application and then the pinned v079-compatible
  rollback build, checking health and signed primary webhook behavior;
- Confirm sender isolation and that neither QA's conflicting 078–104 nor
  optional `ops/qa-only` table DDL ever run in the production migration path;
- Record DB branch/database identity, migration checksums and cleanup;
- Separately approve staging DDL and the later v080–106 forward migration
  rehearsal before secondary sending or history import.

Do not automatically promote the standalone QA capture or switch Meta
callbacks on the strength of green unit/browser CI alone.
