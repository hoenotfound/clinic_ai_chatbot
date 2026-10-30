# Neutro second number: 20h AI / 48h–72h approved marketing rollout

**Source-only preparation. ALL outbound and follow-up flags remain OFF in
production. There are presently no approved templates on the second messaging
account, and no secondary customer may be messaged without fresh consent.**

## Implemented

- **20h in-window follow-up:** Default OFF
  `WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED`. The secondary 2/6/20h
  scheduler still uses its independent one-shot claims and policy checks.
  For 20h, the existing primary Neutro follow-up *AI generator* receives
  only messages from the exact secondary-bound conversation and its latest
  lead. It applies existing assessment-first, duplicate, clinic-claim and
  pricing safeguards, then rechecks policy immediately before saving. No
  independent chatbot, no primary Meta send, and no fallback static message
  if AI personalization is explicitly enabled and fails.
- **48h / 72h post-window:** Default OFF flags
  `WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED` and
  `WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED`. Independent migration
  109 adds sender-owned rules, exact Meta template signatures, operator charge
  approval, and one-shot attempt records. The sender-specific scheduler
  requires the latest real post-import inbound, an explicitly affirmative,
  linked marketing-consent message from the same secondary conversation
  and treatment, current opted-in lead, AI ownership, no booked/completed
  lead, no opt-out and no staff takeover, plus local quiet hours 00:00–07:00.
  One-shot claims never retry after an unknown send.
- **Approval:** A manage-tools user must choose an actual Meta APPROVED
  text-only MARKETING template from the second account's own catalog in the
  mobile-friendly Secondary Follow-up panel, then independently approve
  paid marketing charges on *each* enabled slot. The precise language, name,
  content signature and category are rechecked against Meta before send.
  Primary Meta template IDs and media IDs are never inherited.
- **Billing:** `operator_approved_marketing_template` is a distinct
  audited source. The existing sender billing gate requires an exact
  claimed sender/contact/anchor/template row, and the signed pricing
  receipt must say category `marketing` to auto-reconcile a billable
  attempt. A different category, unconfirmed delivery or missing pricing
  retains the hold. No primary billing rows touched.

## Approval and activation sequence

1. In Meta Billing Hub, activate a payment method for the second account.
2. Submit/approve two matching text-only MARKETING templates for this
   second account, in the intended languages; never copy IDs from primary.
   The customer-facing copy should invite assessment without unsupported
   outcomes, guaranteed recovery or unsolicited prices.
3. Deploy latest `main` while all new flags remain OFF. Run migrations
   before workers start; verify primary WhatsApp, Messenger and signed
   incoming/outgoing status callbacks on the second number.
4. Resolve the existing unknown/unknown billing hold only with separate,
   two-reviewer authorization; the deleted original message is NEVER resent.
5. Confirm explicit sender-specific MARKETING opt-in from a fresh customer
   message, including the clinic name and selected treatment. A CTWA prefill,
   import or previous number's consent is not enough.
6. Enable the secondary regular AI/staff parity mode *first* and verify one
   customer AI message and staff takeover without duplicate sends.
7. Opt in `WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED=true` only
   after verifying the static 2h/6h/20h sender-scoped worker, AI context,
   quiet hours, safe copy and receipt reconciliation.
8. When ready, turn on `WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED`,
   `WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED` and
   `WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED` as a single reviewed
   activation; only after enabling each exact Meta-approved slot in the
   Secondary Follow-up management UI.
9. Test 48h and 72h one at a time with a fresh explicitly opted-in test
   contact. Check signed marketing pricing, no silent retries, and exclusions
   for replies, staff takeover, booking, opted-out or deleted contacts.
   Do not launch a campaign or send messages to imported contacts for tests.

**No automatic sends, schema changes or live Meta calls are part of this PR.**
