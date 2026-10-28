# One-paid-Render WhatsApp app-default router (bootstrap phase)

Status: **DRAFT. NOT AUTHORIZED FOR PRODUCTION, META CUTOVER OR QR SCANNING.**

## Purpose and boundaries

This focused PR adds an opt-in /whatsapp/default route inside the existing paid
Neutro Render app. It does not add a paid service, merge PR #395, change the
existing /webhook endpoint, migrate Neutro's customer tables, or send messages.

- Existing /webhook remains registered with its original handler and Meta HMAC.
- New GET /whatsapp/default checks a separate verification token.
- New POST /whatsapp/default uses the existing raw-body HMAC parser.
- Every signed event is classified by WABA and exact Neutro phone ID.
  Batches containing only unknown/foreign events fail 503, without customer
  processing. If a signed batch includes a valid Neutro message AND unfamiliar
  events, the verified Neutro portion is handled normally while other events
  are recorded as sanitized QA quarantine entries.
- Verified Neutro message/sync events are passed directly to the SAME
  existing Neutro handler, not to a free Render relay.
- Standalone known Neutro account_update and pinned personal-number
  preidentity account_update are committed to independent QA Neon before 200.
- Additional subscribed v26 Meta notifications for the VERIFIED Neutro WABA
  are audited (not operationally processed): account_alerts,
  account_review_update, calls, message_template_quality_update,
  message_template_status_update, phone_number_name_update,
  phone_number_quality_update and security. They never enter the customer
  inbound path. This also covers WABA-level template/account fields without
  a phone ID; an explicitly mismatched phone is rejected.
- Notification-only delivery returns HTTP 200 ONLY after its sanitized,
  idempotent record is committed to isolated QA Neon; QA failures return 503.
  New notification records issue a fingerprint-and-field-only log warning
  requiring MANUAL operator review. No live alert fan-out, template catalog
  refresh, calling implementation or automatic account action exists.
- The QA notification record uses the already-created isolated table
  whatsapp_sender_quarantined_events, reason unsupported_whatsapp_event,
  meaning 'not operationally acted upon', without schema migrations or
  customer payload retention.
- For a mixed signed batch, the unchanged Neutro handler FIRST durably claims
  and acknowledges verified primary events. Only AFTER its successful 200 does
  the QA audit run. If QA Neon is unavailable, Neutro keeps its confirmed 200;
  a sanitized error/fingerprint is logged for manual reconciliation. This is an
  explicit audit-availability tradeoff: the secondary audit could be missing
  and Meta will not retry the already-acknowledged mixed batch.
- No raw customer messages or Meta credentials are written to QA quarantine.
- Secondary customer messages, echoes, history and sender activation are NOT
  enabled. This is not a QR-ready Coexistence webhook.

## Private configuration (none needed while router is OFF)

WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED = false initially (default).
WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN = separately configured private Meta token.
WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164 = independently verified Neutro phone.
WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164 = approved personal QA phone, private.
WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL = isolated QA Neon URI, never production.
WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST = exact hostname of the isolated QA URI.

Existing WHATSAPP_APP_SECRET and META_APP_SECRET must match the real DA CHATBOT
app secret; existing WHATSAPP_WABA_ID and WHATSAPP_PHONE_NUMBER_ID must identify
Neutro; DATABASE_URL stays the current production URI. Never commit secrets.

QA credentials and the optional secondary-number pin are deliberately NOT a
requirement to verify a Neutro primary-only webhook. If QA is misconfigured,
the correctly signed primary message still reaches the existing handler. For
audit records, the QA pin, host, URI, disabled secondary-send switches and
distinct Neon hosts are validated strictly.

The QA URI host must differ from the production URI host and equal the
explicit QA host pin. The QA pool is limited to 2 connections, low timeouts,
and does not run migrations. Audit inserts require the QA schema migration
identities 102, 103 and 104. Unknown events or unavailable QA writes return
503, without falling back to the primary production database.

All secondary outbound and billing switches must remain disabled. The router
rejects configured secondary sender WABA/phone IDs during preidentity bootstrap.

## IMPORTANT: migration conflict

Neutro production was last checked at migration 077. Current main adds sales
follow-up migrations 078 and 079. The old draft PR #395 also uses 078–104 for
DIFFERENT WhatsApp migrations. Do not merge those old files or overwrite
migration checksums. This router PR adds NO extra production SQL migrations.

An emergency rollback candidate is pinned at:
- GitHub branch: safety/neutro-cloudapi-rollback-v079-20261028
- SHA: 9e05a529170a1ea6c51bf93a84eae1f16c5d9dcb
- Base: exact working Neutro production c13d82192c5acca938fdf2a6b7da415004f0a46e

The rollback candidate contains exactly the original Neutro Cloud API code
PLUS the IDENTICAL immutable 078 and 079 SQL files from main, with matching
Git blob IDs c52923dec2a2b5b219a1b811636ad6d218309113 and
7c97e67117b2c59d9d9ec89cd090cd2837baf8e3.

The PR #411 CI checks the pinned rollback commit, old Cloud API source, old
strict migration runner, and exact applied-migration file hashes. This avoids
a normal rollback to c13d821 failing simply because schema 078/079 exists.

DO NOT use the rollback candidate before separately verifying a valid backup,
representative restored schema v079, application health, startup, Meta messaging,
and Neon runtime behavior. A code-only rollback does not undo schema changes.
The rollback candidate MUST NOT be auto-deployed while production is still v077.

## Still required before callback cutover or QR

1. Full signed HTTP integration and existing Neutro regression tests pass.
2. Actual Meta v26 subscriptions were verified in the owner's screenshots:
   messages, account_update, history, smb_app_state_sync, smb_message_echoes,
   account_alerts, account_review_update, calls, message_template_quality_update,
   message_template_status_update, phone_number_name_update,
   phone_number_quality_update and security. Additional Neutro-only operational
   fields are now passively audited. **Not equivalent to processing**: an
   operator must review notifications and implement any necessary lifecycle,
   template/catalog and security actions before the production callback switch.
   Unknown accounts, unknown fields and mismatching phone identity still fail
   closed with 503. Inventory all other accounts subscribed to the same app
   before the cutover so they are not stranded. This bootstrap route remains
   NOT ready for app-default callback cutover.
3. Measure mixed-event and secondary history bursts on 0.5 CPU / 512 MB.
4. Validate the real Meta app secret and verify token without exposing values.
5. Explicitly approve a production deployment and preserve Neutro callback.
6. Separately approve app-default callback cutover after live signed tests.
7. Before QR: implement verified secondary identity binding, history, echoes,
   app-state sync, safe import, disconnect handling and separate consent gates.
8. Keep personal AI, staff sends, templates, marketing and follow-ups OFF.

Rollback: disable secondary processing, restore the original Meta app-default
callback and token, never alter Neutro's account-specific callback, verify
Neutro incoming/outgoing and reconcile uncertain deliveries. No unapproved
Meta callback, QR, production deployment or PR #395 merge is part of this PR.
