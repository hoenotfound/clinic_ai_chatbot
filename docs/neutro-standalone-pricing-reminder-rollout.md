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
  history on secondary, a genuine business reply, and a verified *recent*
  customer treatment mention. Generic hellos, unsupported messages and stale
  CRM-only treatment labels are excluded.
- Normally due ~22h after latest customer message, before a 23h30 safety
  cutoff. When 22h falls inside 00:00-07:00 MYT quiet hours, send earlier at
  23:20 MYT the previous evening if still inside the current service window.
- Verified pricing media already delivered, pricing text already quoted,
  ambiguous service/package, clinical risk, staff ownership, pending review,
  confirmed appointment, opt-out, expired reply window or a changed promotion
  mean no automatic graphic.
- If both pelvis package graphics are required, Meta must accept package A
  before B can be attempted. A partially confirmed set is never replayed.
- Sender-specific API, freeform window, billing gate and final pre-send
  checks remain in force. Meta timeouts and missing/unknown receipts always
  require human review.
- The new message is step 4 for reporting only. It never advances or changes
  the existing 3-step sequence. The existing pricing reminder switch remains
  disabled and independent.

## Release checks

1. CI backend, portal and mobile tests pass.
2. Read-only PostgreSQL EXPLAIN for candidate, pre-send and claim SQL.
3. Inspect one new qualified customer per sender, one already-priced
   customer, one staff handoff, one booked customer and one opt-out.
4. Verify before-end time, quiet hours, signed secondary message context,
   the correct sending phone and the provider/billing receipt.
5. Verify no duplicate graphic and that 2h/6h/20h, consent request and
   48h/66h/96h/144h marketing schedule remain unchanged.
6. Monitor for 24h, then review before enabling another channel.

**Known limitation:** Operator controls are Render flags, not yet shown in
the Tools portal. The feature is intentionally disabled in live production
until activation is explicitly approved.
