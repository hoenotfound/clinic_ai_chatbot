# Phase 2A: Ariel outbound transport (dependent on PR #384)

Status: **developer-only transport, NOT an active second WhatsApp sender**.

This change branches from PR #384's protected multi-number foundation. It does
not modify the existing Neutro Cloud API send path, database schema, Inbox
composer, Meta subscriptions, Neon database, or Render environment.

## What has been implemented

The module `src/services/whatsappSenderOutboundTransport.js` implements the
Cloud API request transport for a **verified secondary conversation**:

- Resolves Ariel's sender and customer identity from the authoritative
  `contacts`, `whatsapp_sender_conversations`, and
  `whatsapp_sender_accounts` join. A caller cannot choose a sending number.
- Requires all staged receiving/identity flags and the additional
  `WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED=true` opt-in, currently OFF.
- Uses independent secondary Meta phone ID, WABA, and token with no primary
  token or phone fallback, and rechecks the sender binding and credential
  before every outbound HTTP request.
- Supports text, interactive reply buttons, HTTPS image, uploaded images,
  video, documents, stickers, audio/voice, media upload and raw template
  payload transport. Media upload and delivery use the same verified phone.
- Does not retry ambiguous provider sends. An HTTP acceptance is not a
  delivery receipt.
- Never exposes its token through its returned interface or its logs.

**No existing production entrypoint imports this transport.** The staging
flag must NOT be enabled and Ariel must remain Inbox-only until the work below
is complete. The template payload method does not itself establish approval
or consent, and must never be wired directly to a customer-facing endpoint.

## Still required before any Ariel API sending

1. Sender-specific 24-hour policy and staff reply checks, including
   isolation from Neutro's contact history and current customer window.
2. Sender-specific billing, CTWA free-entry, opt-in/out, reservation gate,
   template catalog approval and consent, plus template/media-cache ownership.
3. Sender-qualified outbound receipts, delivery-status processing,
   reconciliation, attention alerts, deduplication and retry jobs.
4. Integrate verified transport into Inbox staff, AI and follow-up dispatch
   only *after* their sender-specific policy gates are complete.
5. Verify phone/WABA/token ownership with Meta, do a fresh Neon staging
   migration rehearsal and a two-number E2E send/receive/status test.
6. Release with explicit activation approval and tested rollback.

## Verification

`node --test test/whatsappSecondaryOutboundTransport.test.js`

The transport tests use a fake database and fake Graph API response. They
exercise sender identity mismatches, feature-off defaults, Neutro fallback
prohibition, payloads and media targets, unknown-outcome handling and sender
revocation between creating a transport and sending a message.

No live Meta messages should be sent by this PR.

## PR dependency

- PR #384: multi-number foundation, still Draft.
- This PR: independent outbound transport and isolation tests.
- Follow-up PR: per-number policy, billing, approved templates and receipts.
- Later: connect staff/AI/media to this transport and perform live E2E checks.

Do not merge to an auto-deploying main branch or treat a green CI run as
permission to activate Ariel without the staging/rollback release gates.
