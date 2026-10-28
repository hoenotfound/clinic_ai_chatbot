# One-paid-Render WhatsApp app-default router (bootstrap phase)

Status: **DRAFT. NOT AUTHORIZED FOR PRODUCTION, META CUTOVER OR QR SCANNING.**

## Purpose and boundaries

This focused PR adds an opt-in /whatsapp/default route inside the existing paid
Neutro Render app. It does not add a paid service, merge PR #395, change the
existing /webhook endpoint, migrate Neutro's customer tables, or send messages.

- Existing /webhook remains registered with its original handler and Meta HMAC.
- New GET /whatsapp/default checks a separate verification token.
- New POST /whatsapp/default uses the existing raw-body HMAC parser.
- The entire signed batch is verified by WABA and, for customer-related Neutro
  events, the exact Meta phone ID. Unknown accounts and event fields fail 503.
- Verified Neutro message/sync events are passed directly to the SAME
  existing Neutro handler, not to a free Render relay.
- Known Neutro account_update and pinned personal-number preidentity
  account_update are committed to the independent QA Neon database before 200.
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

The QA URI host must differ from the production URI host and equal the
explicit QA host pin. The QA pool is limited to 2 connections, low timeouts,
and does not run migrations. Audit inserts require the QA schema migration
identities 102, 103 and 104. Unknown events or unavailable QA writes return
503, without falling back to the primary production database.

All secondary outbound and billing switches must remain disabled. The router
rejects configured secondary sender WABA/phone IDs during preidentity bootstrap.

## IMPORTANT: migration conflict

Neutro production was last checked at migration 077. The current main branch
already adds sales follow-up migrations 078 and 079. The old draft PR #395
also uses numbers 078 through 104 for DIFFERENT WhatsApp migrations. Do not
merge those old files, overwrite migration checksums, or deploy this PR until
the current main migrations and production backup/restore path are approved.
This focused router PR adds no production SQL migrations.

## Still required before callback cutover or QR

1. Full signed HTTP integration and existing Neutro regression tests pass.
2. Review the real subscribed Meta fields and add explicit handlers for
   template, quality, security and other app-default events: unknown fields
   intentionally fail closed in the bootstrap route.
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
