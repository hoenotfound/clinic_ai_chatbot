# Secondary WhatsApp: first-ad contact-only sync review

## Why this exists
Meta coexistence contact sync and chat-history sync are separate. The imported
chat history may only cover the most recent six months. A number present in the
contact sync with no imported messages is **not** proven to be a new customer.
Do not automatically upgrade pre-activation contacts based on zero DB messages.

## What changes
- New secondary contacts whose **first** provider message is a verified
  post-activation Meta Click-to-WhatsApp ad continue through existing AI rules.
- Pre-activation/contact-only contacts stay manual, even if they send an ad
  enquiry, until a named operator checks the complete full secondary WhatsApp Business App history and the primary number's
  complete available history from its authoritative business records.
- If *either* number has an earlier customer/business conversation, or staff
  cannot reliably verify the full history, record `historical_or_unknown`;
  keep AI blocked. The absence of six-month imported history is not proof.
- If both numbers' authoritative histories have been checked and there was genuinely no
  prior conversation, record `no_prior_conversation_verified` for the exact
  first verified ad message. The stored decision includes an operator, both
  independent checks, and an explanatory note.
- The runtime still requires a bound secondary sender, ad referral, valid
  activation, unchanged first-message evidence, no imported historical
  messages and no older primary records or primary conversation evidence.
- A later discovered historical chat blocks the recipient even after a review.
- An approval never reprocesses a completed inbound or replays an unanswered
  old AI reply. Previously scheduled marketing and sales follow-ups anchored
  before the operator's review are blocked as well.

## Operator workflow
1. Open the contact in the Inbox and the secondary WhatsApp Business App and the primary number's authoritative
   chat records; inspect the **complete** conversation history, not only the six-
   month import. If the primary number has no Business App, use its
   authoritative CRM/WhatsApp history instead. If older history on either
   number is unavailable, do not approve.
2. Ensure the first real customer message belongs to the secondary number,
   and contains a verified Meta ad referral. A later ad click after a direct
   or historical chat cannot qualify.
3. Record a review only after checking both history sources. Use the logged
   operator username and a note explaining the evidence. This is a database
   administration action, not a WhatsApp outbound API call.
4. Check the decision in the read-only audience selector. **Do not replay**
   the original inbound job or manually send an automated response. AI may
   respond to *future* eligible incoming messages only.
5. If historical evidence appears, update the decision to
   `historical_or_unknown` immediately. Other sender, opt-out, billing and
   staff ownership checks remain independent.

Example administrative transaction. Substitute the reviewed contact ID,
first inbound message ID, operator and evidence note only *after* both app
histories have been checked:

```sql
BEGIN;
INSERT INTO whatsapp_secondary_ad_eligibility_reviews
  (contact_id, origin_message_id, decision, reviewed_by,
   secondary_app_history_checked, primary_history_checked, review_note)
VALUES (
  :contact_id, :first_ad_message_id, 'no_prior_conversation_verified',
  :reviewer, TRUE, TRUE, :documented_history_review
)
ON CONFLICT (contact_id) DO UPDATE
  SET origin_message_id = EXCLUDED.origin_message_id,
      decision = EXCLUDED.decision,
      reviewed_by = EXCLUDED.reviewed_by,
      secondary_app_history_checked = EXCLUDED.secondary_app_history_checked,
      primary_history_checked = EXCLUDED.primary_history_checked,
      review_note = EXCLUDED.review_note,
      reviewed_at = NOW();
COMMIT;
```

If evidence is unavailable, do not run this approval transaction. For a
known historical/uncertain contact, the review decision must remain
`historical_or_unknown`.

## Telegram staff-waiting alerts
The alert now checks the secondary sender and AI audience once at alert creation.
When secondary AI is blocked, staff are directed to the WhatsApp Business App.
The `Return to AI` switch does not override eligibility and never replays the
old message. No existing Telegram alert records need to be resent or deleted.

## Release checklist
- Run schema migration 116 before enabling the new code.
- CI: pure-JS eligibility tests, staff alert tests, and PostgreSQL integration.
- Check a new secondary first-ad lead still qualifies.
- Check imported history, an earlier primary contact, unknown contact-only
  sync, and a later ad click remain blocked.
- Verify reviewed contact-only first-ad approval and later primary/history
  evidence revocation.
- Verify no pre-review follow-up anchor becomes sendable.
- Deploy without automatically approving *any* existing contacts, especially
  Jovial (contact 8560). No customer message should be sent by this release.
