# Phase 2C: verified the secondary WhatsApp sender receipt staging and retry holds

> **Target updated 2026-10-23:** Secondary = 中医养生馆 (+60 17-483 1336), phone ID `1318355951360575`, account ID `1071636698738276`. The original secondary number's content approval does not transfer. Keep all sends and Meta coexistence activation OFF until independently verified and authorized.


Status: **development-only, no live webhook or outbound integration**.

This PR depends on Phase 2B (#389), which depends on #387 and #384.
No Neutro production handler, polling worker, Meta subscription, Render setting,
Neon production row, existing migration, or primary WhatsApp billing table is
changed by this PR.

## Included

- Additive migration 084 introduces `whatsapp_sender_status_receipts`
  with sender/attempt foreign keys and a SHA-256 replay fingerprint.
  Unmatched statuses are recorded as hashes of the provider WAMID,
  without storing customer phone numbers, messages or raw payloads.
- New `whatsappSecondaryReceiptService` verifies the HMAC-SHA256 over
  the **original raw webhook bytes**, requiring `WHATSAPP_APP_SECRET`.
  Unlike the legacy development webhook middleware, there is no unsigned
  development-mode exception here.
- Every event in a batch must be a status callback for **the secondary sender's exact
  Meta account and receiving phone**; mixed Neutro/the secondary WhatsApp sender callbacks,
  inbound message payloads, unknown fields, malformed statuses and
  unverifiable signatures are all refused before any database write.
- The sender-specific saved outbound attempt is verified against its
  reserved WAMID, recipient, bound conversation, message context,
  sender key, phone/account, and unresolved billing gate under a
  transaction. No bare phone or WAMID alone selects a send.
- Matched statuses are journaled without changing Neutro's receipt,
  billing or retry records. Signed status replays are idempotent.
  Callbacks with no matching the secondary WhatsApp sender outbound attempt are recorded as
  unmatched privacy-minimized events.
- Failed and billable receipts move an the secondary WhatsApp sender attempt to a durable
  `unknown` billing state. Later delivered/read or nonbillable
  receipts do **not** automatically clear this hold.
- `inspectSecondaryRetryHold` is **read-only**. It always returns
  `canAutoRetry: false`. No secondary retry or reconciliation worker
  sends any message in this PR.
- PostgreSQL integration and unit tests exercise real sender/billing
  record isolation, replay, failed/billable hold, wrong receiver,
  unrecognized recipient and the independent primary gate.

## Deliberate release boundaries

- `WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED=false` by default.
- All earlier the secondary WhatsApp sender flags must remain OFF. No route imports the new
  receipt service. Production still quarantines the secondary WhatsApp sender status callbacks
  rather than passing them to this service.
- Signed provider receipts prove only what Meta reported. Pricing
  `billable=false` is not a substitute for an approved overall
  customer-send policy. The new callback service deliberately **never**
  unlocks a reservation, not even after a nonbillable receipt.
- The staged ledger is not permission to start sending or to retry.
  Unknown/ambiguous sends remain held across restarts.
- No new token values, sender IDs, or production DB data are added.
- Migrations 078–084 still require an isolated Neon production-snapshot
  cutover/rollback rehearsal before any auto-deploying merge.

## Remaining Phase 2 integration work

1. Decide and implement audited secondary reservation settlement for
   verified nonbillable outcomes, billable outcomes, conflicts and
   manual Billing Hub reconciliation. It must never clear an
   `unknown` gate on timeout or later contradictory receipt alone.
2. Integrate this handler into the post-signature Meta webhook partition
   without bypassing the existing primary sender and quarantine logic.
   Confirm out-of-order callbacks, concurrent workers, callback retries,
   provider echoes, and Business App coexistence behavior.
3. Authorize secondary sending only in a new sender-specific dispatcher
   with a final 24-hour/consent check, approved templates and an atomic
   billing reservation. Keep the primary dispatcher untouched.
4. Implement independent media caches, queued sends, follow-ups and
   delivery alerts; prohibit automatic retries for any send that may
   have reached Meta.
5. Test both numbers on isolated Neon with exact Meta phone/WABA ownership
   and callback subscriptions, then plan a verified production rollback.

## Test coverage

Run `node --test test/whatsappSecondaryReceiptService.test.js`.
The PostgreSQL suite
`test/whatsappSecondaryReceiptPostgres.integration.test.js`
requires `TEST_DATABASE_URL` and is included in the CI backend job.
Full `npm test`, static frontend and Playwright browser suites run on
the CI-only temporary draft PR against main.
