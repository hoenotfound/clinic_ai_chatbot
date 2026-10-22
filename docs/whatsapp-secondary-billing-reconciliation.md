# Phase 2D: manual billing reconciliation and late adverse receipt protection

Status: **development-only, no live webhook, outbound dispatcher, or operator endpoint**.

Depends on #391 → #389 → #387 → #384.

## Added in this PR

- Migration 085 adds an immutable-per-reservation manual reconciliation audit and
  a sender-level **latched** billing alarm. Both are additive to Phase 2.
- The signed Ariel receipt inspector can now associate a verified callback with
  a historical `reconciled` attempt, even after the sender gate has returned
  to idle or is processing a later reservation. A late billable or failed
  receipt latches a sender-wide alarm.
- The separate Ariel billing reservation repository checks for this alarm
  under the same sender gate row lock before reserving any new message.
- The disabled-by-default manual settlement service requires a currently
  active Ariel sender, exact pending reservation + bound message, provider
  WAMID, a signed matched Meta nonbillable free-entry receipt, no adverse
  receipts for that attempt, no unmatched same-WAMID receipts, and no sender
  alarm. The human operator must separately attest to verifying Meta Billing
  Hub, giving reviewer identity and a reason. All conditions are rechecked
  within a single database transaction.
- Successful settlement makes the previous attempt `reconciled`, writes
  an immutable audit, and returns the sender gate to idle. **It never sends
  or retries a message and never authorizes either action.**
- An ambiguous `unknown` reservation or conflicting/billable provider
  evidence CANNOT be cleared by this service, even with the review flag.
  Those cases require a future separate explicit escalation workflow.
- Integration tests use real PostgreSQL and the existing dual-sender
  fixtures. They cover valid manual settlement, missing/wrong receipt,
  missing human confirmation, replay, mismatched callback recipient,
  and a **late billable callback after settlement and a newer reservation**.

## Safety, limitations and next work

- `WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED` remains OFF.
- No production code imports `whatsappSecondaryReconciliationService`.
  This is **not an admin API** and must not be exposed without authenticated
  reviewer identity, authorization, CSRF protection and audit controls.
  A `billingHubConfirmed` boolean alone is a human attestation, not
  proof of Meta Billing Hub inspection.
- No automatic replay, sender-level alarm release, or change to Neutro's
  existing billing tables. A latched alarm requires future controlled
  investigation and cannot be reset by this code.
- A live dispatcher will need a **final sender-alarm and policy recheck
  immediately before each Graph API request**, including after a reservation
  was already made. Neither this PR nor its parents enable that dispatcher.
- Releasing one verified `free_entry_point` nonbillable attempt is only
  narrow billing reconciliation, not blanket approval for the next send.
  A later attempt must independently pass the sender's reply window,
  marketing consent, template approval, and billing checks.
- Live webhooks continue quarantining Ariel status callbacks until signed
  multi-sender ingress is reviewed and enabled in a later PR.
- No Meta subscriptions, Render secrets, production Neon data, or live
  service configuration were changed.

## Verification

Run `node --test test/whatsappSecondaryReceiptPostgres.integration.test.js`
with `TEST_DATABASE_URL` configured. Repository CI supplies PostgreSQL.
Existing full `npm test` and Playwright checks are validated separately
using a temporary Draft PR targeting `main`.

**Do not merge the full PR chain or enable Ariel's sending flags until the
signed ingress adapter, final send gating, media and follow-up isolation,
Neon snapshot rehearsal and two-number Meta tests have been completed.**
