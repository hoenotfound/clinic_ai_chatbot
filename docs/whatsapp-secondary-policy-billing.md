# Phase 2B: sender-specific WhatsApp policy and billing groundwork

> **Target updated 2026-10-23:** Secondary = 中医养生馆 (+60 17-483 1336), phone ID `1318355951360575`, account ID `1071636698738276`. The original secondary number's content approval does not transfer. Keep all sends and Meta coexistence activation OFF until independently verified and authorized.


Status: **Draft. This is not an the secondary WhatsApp sender sending release.**

This change depends on PR #387, which itself depends on foundation PR #384.
All files are additive except the existing PostgreSQL migration rehearsal test,
which now expects the new migration. No existing Neutro sender, template,
follow-up, strict-RM0, retry or delivery-status code has been changed.

## Implemented

- `whatsappSecondaryPolicyService`: read-only, fail-closed service-window
  preview. It looks up only inbound messages attached to the secondary sender's verified
  `whatsapp_sender_conversations` record; a customer message received by
  Neutro does not reopen the the secondary WhatsApp sender service window.
- Explicit opt-in and opt-out checks for the the secondary WhatsApp sender contact. Promotional
  template preview additionally checks a consent event on the current lead
  and, for customer-authored evidence, the same sender-qualified message.
- A separate, uncached approved template lookup targeting the secondary sender's own WABA
  with the secondary sender's token. It fails closed on missing/ambiguous approval, API errors,
  pagination and unexpected categories.
- CTWA evidence is informational only. It is bound to the exact the secondary WhatsApp sender contact,
  sender conversation, Meta receiving phone and Meta account ID. The existing
  primary-number free-entry and seven-day assumptions are not reused.
- Migration 083 adds `whatsapp_sender_billing_gates` and append-only
  `whatsapp_sender_billing_attempts` (except state/provenance updates).
  Composite contact/sender foreign keys prevent binding the secondary WhatsApp sender billing
  reservations to Neutro contacts.
- `whatsappSenderBillingGateRepo`: guarded, atomic per-sender reservation
  and provider-acceptance/unknown recording. A previous reserved, accepted
  or ambiguous send blocks new reservations for that sender until a future
  reconciliation implementation verifies the outcome.
- PostgreSQL integration tests validate migration 083, identity isolation,
  cross-sender foreign keys and the same-customer/two-number scenario.

## Safety restrictions

1. `WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED` defaults OFF.
2. `WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED` defaults OFF.
3. `WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED` from PR #387
   **must remain OFF**.
4. A policy preview may return `policyAllowed: true`, but every response
   explicitly returns `sendAuthorized: false`. A billing reservation likewise
   returns `sendAuthorized: false`. None of these are final send permissions.
5. No production route, follow-up worker, portal Inbox composer, or existing
   WhatsApp API sender imports the new policy/billing components.
6. Neither this PR nor #387 installs the secondary sender's Meta credentials, activates
   coexistence, changes webhook subscriptions, writes to production Neon, or
   deploys to Render. The PRs should stay Draft.

## Remaining Phase 2 requirements before sender activation

- Bind policy snapshots, approved template catalog and atomic billing
  reservations to a single verified sender-specific dispatch transaction.
  Re-evaluate the 24h window immediately before Meta sends.
- Implement provider-status, pricing-receipt and verified reconciliation
  workers that match phone ID, WABA, WAMID and reservation before unlocking
  a sender. Unknown outcomes must never auto-retry or silently clear.
- Implement sender-specific staff/AI templates, follow-ups, consent handling,
  scheduled jobs, pending reactions, media caches and safe retries.
- Review business-wide versus per-number marketing opt-out semantics.
- Conduct isolated production-snapshot Neon migration rehearsal
  `077 -> 083`, followed by both-number Meta tests and a verified rollback.
- Obtain explicit operator approval before any production change.

The new billing tables deliberately keep an unresolved attempt blocked.
Forgetting or deleting the contact must not become a backdoor to unverified
retries; review privacy retention/delete behavior before integrating billing
attempts into normal customer deletion workflows.

## Test commands

```bash
node --test test/whatsappSecondaryPolicyService.test.js
TEST_DATABASE_URL=postgresql://... node --test test/whatsappSecondaryBillingGatePostgres.integration.test.js
npm test
```

The PostgreSQL tests skip outside a configured test database. The existing
CI workflow supplies PostgreSQL for the backend suite.
