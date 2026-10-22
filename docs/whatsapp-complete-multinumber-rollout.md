# Consolidated WhatsApp multi-number integration — Neutro + Ariel

This branch is the **only Phase 2 development PR**, replacing old draft
PRs #384, #387, #389, #391 and #393. It is **NOT approved for production
merge, deployment or Meta activation**.

## Implemented on this branch

1. Sender-qualified contact, conversation, inbound message and media identity
   for two business numbers. Existing Neutro contact/message history remains
   preserved and the original primary token/phone stay untouched.
2. Standalone Ariel Cloud API transport with database-verified business
   ownership, read-only sender-specific 24-hour policy, opt-in/opt-out,
   template catalog and CTWA evidence previews.
3. Independent Ariel billing reservation, signed status receipts, manual
   nonbillable reconciliation and persistent late/billable alarm. Unknown
   outcomes are **not auto retried**.
4. Signed webhook receipt ingress (disabled): captures the original raw
   HMAC-verified bytes, independently verifies the signature for Ariel's
   receipt recorder, selects only exact Ariel WABA/phone statuses from a
   mixed sender callback, and durably saves them before HTTP 200.
   Primary Neutro status handling remains the existing pipeline.
5. Staff **text** dispatch (disabled) now uses Ariel's independently verified
   sender, 24-hour window, original outbound message identity, per-sender
   billing reservation, alarm and final pre-send checks. A saved outbound
   message can have only one secondary sender billing attempt (migration 086).
6. AI **text** dispatch (disabled) reuses the same sender-specific send
   safeguards and existing durable AI attempt/staff cancellation guards.
   Secondary optional promo media/result-media sends are suppressed.
7. Unit and PostgreSQL regression tests for cross-number isolation,
   signed mixed webhook parsing/acknowledgement, sender ownership, closed
   service windows, duplicate sends, provider timeout and late billing
   alarms.

## Environment switches — ALL default OFF

```
WHATSAPP_MULTI_NUMBER_READ_ENABLED=false
WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=false
WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=false
WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED=false
WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED=false
WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED=false
WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED=false
WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED=false
WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED=false
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=false
WHATSAPP_SECONDARY_AI_SEND_ENABLED=false
```

Do **not** enable these together to test on live Neutro. Production
database schema/Meta subscriptions/credentials and callback content must
be independently verified first.

## Not ready yet

- Ariel media (image/video/audio/document/sticker), templates and extended
  follow-up senders still need **end-to-end sender-bound dispatch**.
  The secondary transport primitive alone is not an authorization gate.
- Sender-specific billing operation currently reserves at most one unresolved
  outbound per Ariel sender; a human Billing Hub settlement is required
  before another reservation. That is intentionally too restrictive for
  normal automated production use. Full pricing/settlement behavior must
  be designed and tested before turning on the AI switch.
- Need autonomous authenticated sender-specific delivery-status recovery,
  operational billing alerts, controlled unblocking and reconciliation
  for legitimate billable conversations. Never automatically clear an
  ambiguous state or an adverse receipt.
- Media/template send paths in existing Inbox remain **blocked** for Ariel.
  Reactivating them without isolation would risk using Neutro's token.
- Need full database migration rehearsal on a production-shaped **isolated**
  Neon branch, callback replay/ordering tests, consent audit, front-end sender
  indication, staff workflows, and real Meta coexistence testing with
  both phone IDs and a verified rollback plan.
- Existing primary sender must keep working under an optional-flag
  rollback. Do not automatically revert sender-aware reads after creating
  durable Ariel contacts.

## Merge policy

Do not merge until CI is fully green, end-to-end tests pass under both
sender configurations, WhatsApp media/template/follow-up paths are
isolated, and an operator approves controlled rollout.
Closing earlier draft PRs does not authorize deployment.
