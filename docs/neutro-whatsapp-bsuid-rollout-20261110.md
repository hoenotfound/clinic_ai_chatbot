# Neutro secondary WhatsApp: BSUID compatibility (10 November 2026)

## Scope
Meta's 2026 WhatsApp usernames can hide a customer's phone. The signed
WhatsApp Cloud API webhook may instead identify the customer by a portfolio-
scoped `user_id` (BSUID) such as `MY.Abc123`. A display username (such as
`@Peggyteoh`) is **not** a sendable identifier.

This patch supports signed phone-visible and BSUID-only inbound on both
WhatsApp senders. Direct Meta Cloud API input uses `from_user_id` on
messages, `contacts[].user_id`, and `contacts[].profile.username`
(display-only); delivery statuses use `recipient_user_id`, and Business
App Coexistence echoes can use `to_user_id` without a phone.
The canonical contact key remains stable while sender-scoped BSUID and
last signed customer address are recorded. Outbound Cloud API sends use
`to` for phones or `recipient` for BSUIDs. Sender, recipient, reservation,
WAMID, current service window, billing and cancellation are all checked;
social channels are unchanged. No lookup uses a display username or ad text.

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

## Five review findings addressed
- Direct Cloud API field names: `from_user_id` and contact
  `profile.username`, including no-phone payloads.
- Status field names: `recipient_user_id` plus `recipient_id`.
  Each secondary reservation saves the exact intended recipient. Early
  dual-ID receipts retain both recipients as SHA256 digests until verified.
- Staff echoes: `to_user_id` is recognized even without `to`,
  inbound recipient evidence is not overwritten by a staff message,
  and cancellation is applied to both verified phone and BSUID keys.
- Primary number: text, media and template requests use the correct
  destination form; strict billing selects BSUID-specific contact policy
  only when the recipient is a BSUID. Existing phone SQL stays unchanged.
- Receipt race: latest inbound address can change, but receipt matching
  requires the destination saved on that specific outbound attempt,
  sender identity, conversation and WAMID.

## Safe verification
1. Apply migration 120 on an isolated Neon branch. It adds nullable contact
   identity fields, per-attempt recipient evidence, one additional SHA256
   receipt field, small lookup indexes, and BSUID-compatible checks.
2. Run backend tests and PostgreSQL integration; confirm ordinary phone
   messages, main sender, social messages, staff echoes, and 131060 recovery.
3. Confirm signed BSUID-only inbound creates one secondary contact/job.
   A later incoming text and a phone-visible message with the same user_id
   must reuse that contact and preserve the original conversation and lead.
4. Confirm primary and secondary BSUID replies use Graph API `recipient`
   (not `to`), while ordinary phone sends use `to`. Exercise text,
   media, templates, strict billing, opt-outs and service-window checks.
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
