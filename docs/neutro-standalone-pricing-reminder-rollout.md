# Neutro standalone missing-pricing reminder

Status: **OFF by default**. This is an isolated future pricing lane, not a change
to the clinic's assessment-first AI replies or the 2h/6h/20h / extended follow-ups.

## Rollout flags

Set on the Neutro Render service only. All default to off.

- `NEUTRO_STANDALONE_PRICING_REMINDER_ENABLED=true`
- `NEUTRO_STANDALONE_PRICING_REMINDER_ACTIVATED_AT=<new current UTC timestamp>`
- `NEUTRO_STANDALONE_PRICING_PRIMARY_ENABLED=true` (optional)
- `NEUTRO_STANDALONE_PRICING_SECONDARY_ENABLED=true` (optional)

Do **not** enable before CI, a read-only live cohort query, a supervised
test of a single fresh, consenting contact on EACH sender and signed Meta
receipt/billing reconciliation. Messenger and Instagram are deliberately
excluded; Messenger image delivery remains unverified. Switch any flag to
false to stop NEW claims. Already attempted/unknown messages must be reconciled
manually and never replayed blindly. Do not backdate the activation timestamp.

## Eligibility

- Only Neutro Sense, and only actively enabled primary/secondary sender.
- A new, provider-identified customer inbound after activation, sender-bound
  history, a genuine business reply, and a verified *recent*
  customer treatment mention. When a customer's latest wording is vague,
  a recently verified WhatsApp ad on the same sender may identify the
  treatment; otherwise a recent, provider-verified consent event for the
  latest lead's exact treatment may supply the fallback. Generic hellos with
  no recent evidence, unsupported messages, comparison enquiries, conflicting
  ad treatments and stale CRM-only treatment labels remain excluded.
- A current lead marked opted-in with customer-authored, WhatsApp provider-verified,
  **treatment-specific marketing consent bound to that exact sender** is required.
  A CTWA click, prefilling an enquiry, or simply staying inside 24 hours does
  not grant permission to send an unsolicited pricing promotion. The latest
  selected service must also match the consenting current lead; absent or
  conflicting proof skips the graphic. Both the initial scan and final
  pre-send check enforce this rule.
- Normally due ~22h after the latest customer message, before a 23h30 safety
  cutoff. If 22h falls in 00:00-07:00 MYT quiet hours, use 23:20 MYT the
  previous evening only if at least 20h has elapsed since the customer message.
  Otherwise skip rather than send an early or overnight offer. Other quiet
  hour configurations fail closed when the scheduled time is quiet.
- Verified pricing media already delivered, pricing text already quoted,
  ambiguous service/package, clinical risk, staff ownership, pending review,
  confirmed appointment, opt-out, expired reply window or a changed promotion
  mean no automatic graphic.
- For pelvic Package A+B, primary sends B only after A has a saved accepted
  WAMID. Secondary requires A's matched signed *successful* delivery receipt
  AND a cleared sender-specific billing gate before claiming B. An interrupted
  or uncertain package is never automatically replayed.
- Confirmed pre-provider blocks use the existing pricing reminder backoff
  (30 seconds, 1 minute, 2 minutes, at most three attempts); queued rows are
  reused only when there is no unresolved billing attempt or provider receipt.
  Failed/unknown Meta outcomes always require staff review.
- Attempts and skips are recorded in the separate migration 127 audit table.
  This leaves the legacy pricing reminder's constrained decision table
  completely untouched.
- Standalone decisions appear in the existing Follow-up Activity and Health
  screens, honoring the same contact-access permissions. Ordinary skips stay
  in the activity log; ambiguous/manual-media and uncertain delivery reviews
  appear as attention events. Actionable new reviews also set the existing
  Inbox attention flag without replacing higher-priority clinical/booking holds.
- For staff-uploaded images using a new R2 key, a **confirmed**, distinctive
  matching caption is treated as already sent. A captionless or short pricing
  image from the current conversation cannot be proven identical from its URL;
  it is held for a staff check rather than resent automatically. The classifier
  never fetches customer media bytes or scans unrelated contacts. Images with
  clear unrelated captions are left alone.
- Sender-specific API, freeform window, billing gate and final pre-send
  checks remain in force. Meta timeouts and missing/unknown receipts always
  require human review.
- The pricing worker is lowest priority, with at most two accepted images per
  pass. It runs after regular follow-ups, legacy pricing and consent prompts.
  The new message is step 4 for reporting only. It never advances or changes
  the existing three-step sequence. The legacy pricing reminder switch must
  remain disabled.

## Release checks

1. CI backend, portal and mobile tests pass, including the stable daytime
   PostgreSQL fixtures for 131060 and the six-day sequence.
2. Apply and verify migration 127 in the intended database; check read-only
   PostgreSQL EXPLAIN for candidate, pre-send and claim SQL.
3. Inspect one new qualified customer per sender, one already-priced
   customer, one staff handoff, one booked customer and one opt-out.
4. Verify before-end time, quiet hours, signed secondary message context,
   the correct sending phone, A/B signed billing receipts, safe preflight
   retries and the new audit rows.
5. Verify no duplicate graphic and that 2h/6h/20h, consent request and
   48h/66h/96h/144h marketing schedule remain unchanged.
6. Monitor for 24h, then review before enabling another channel.

**Known limitation:** Operator controls are Render flags, not yet shown in
the Tools portal. The feature is intentionally disabled in live production
until activation is explicitly approved.
