# Neutro secondary WhatsApp: BSUID compatibility (10 November 2026)

## Scope
Meta's 2026 WhatsApp usernames can hide a customer's phone. The signed
WhatsApp Cloud API webhook may instead identify the customer by a portfolio-
scoped `user_id` (BSUID) such as `MY.Abc123`. A display username (such as
`@Peggyteoh`) is **not** a sendable identifier.

This patch supports signed phone-visible and BSUID-only incoming text for
the **secondary sender-scoped** integration, retaining the original canonical
contact key while recording a verified user_id and the last observed provider
address. It sends to a phone with `to` or a BSUID with `recipient`, and
validates status receipts against the exact sender, bound conversation,
reservation and WAMID. The primary and social channels retain existing
behavior. No user lookup based on username, similarity, or ad prefill is allowed.

## Operational limitations
- The photographed Peggy enquiry at 4:01/4:02 PM was not in the Neutro DB.
  That alone does **not** prove Meta delivered a BSUID webhook or that this
  patch would recover the historical messages. Confirm against Meta's
  original delivery logs with the correct developer-app administrator.
- Webhooks that **never reach** the server cannot be reconstructed; no polling
  or Meta message scraping is introduced.
- A past phone-number-only contact with no previously stored user_id cannot
  safely be merged with a later BSUID-only contact without provider proof.
  Manual identity review may be necessary; the bot must not guess.
- If a recipient address changes between outbound acceptance and a delayed
  delivery receipt, the existing strict receipt owner checks can retain an
  unmatched status for manual review. Do not automatically reconcile by WAMID
  alone, release a billing gate, or resend uncertain messages.
- No historical backfill; no explicit automatic app configuration change.

## Safe verification
1. Apply migration 120 on an isolated Neon branch. It only adds nullable
   contact fields, a unique sender-scoped user_id index, and expands the
   conversation address check to strict BSUIDs.
2. Run backend tests and PostgreSQL integration; confirm ordinary phone
   messages, main sender, social messages, staff echoes, and 131060 recovery.
3. Confirm signed BSUID-only inbound creates one secondary contact/job.
   A later incoming text and a phone-visible message with the same user_id
   must reuse that contact and preserve the original conversation and lead.
4. Confirm a BSUID reply uses Graph API `recipient` (no `to`), ordinary
   phone sends use `to` (no `recipient`), and all existing billing/opt-out/
   service-window checks still run before dispatch.
5. Confirm status receipts reconcile only with exact authorized sender,
   recipient, WAMID and reservation. Unknown recipients remain unmatched.
6. Test a customer who arrives from a Meta ad and then asks `Location?`,
   including a username-only customer and an ordinary phone customer.
7. Check safe Render diagnostic lines
   `[Secondary WhatsApp inbound identity] bsuid_claim_accepted` or
   `[Secondary WhatsApp inbound claim] <category> kind=<type>`.
   No phone, BSUID, username or message body is logged.
8. Verify the business's actual Meta app webhook subscription and overrides
   with a Meta developer-app administrator. A different login showing no
   accessible developer app is not evidence of missing live subscription.

## Deployment
Do not deploy automatically with the PR. Merge only after CI and controlled
live Coexistence testing on the actual secondary number. This PR does not
activate PR #569's 131060 recovery flags. Reverting runtime code is safe only
after verifying whether any new BSUID-only contacts have been stored, since
older code cannot process them.
