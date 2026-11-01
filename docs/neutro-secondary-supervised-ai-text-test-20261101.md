# One-contact supervised secondary WhatsApp AI text test (PREPARATION ONLY)

**Not activated by this PR.** All production Render flags, billing, provider messages and database rows must remain untouched until a separate supervised approval. Scope: Neutro second WhatsApp number 中医养生馆, **contact ID 8863 only** (verified by the owner using their own WhatsApp at 10:21 MYT on 1 Nov 2026).

## Why a separate test_only mode

The ordinary `ads_only` audience must keep admitting only new provider-verified ad leads, never a manually contacted person. The test does not create a fake ad referral, marketing opt-in or identity proof. `test_only` makes the existing Ads-Only eligibility return **false for everyone**, including real ad leads. An independent one-contact check applies only to the **`ai_reply` text dispatch**, not media, staff messages, follow-ups, summaries, lead scoring or templates.

The personal contact must be the previously observed sender-bound, nonimported contact created at 02:21 UTC on Nov 1, sender database ID 2, with a fresh verified customer inbound inside the 24-hour service window. This one-contact eligibility is checked at inbound classification and repeatedly at the outbound dispatcher before Meta, independently of message generation. Missing database, different identity, opt-out, staff attention, no recent customer inbound or expired time gate means **no AI send**. It does not modify existing consent/marketing/billing state.

## Activation configuration (NOT to apply from this PR)

1. After CI passes and an independent review, merge and deploy the test code with **all secondary outbound and AI flags OFF**. Confirm primary WhatsApp and Messenger, signed webhook, secondary sender identity, credential and billing receipt readiness.
2. For the *test only*, choose `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=test_only`, **not** `ads_only`. This deliberately keeps all new ad contacts manual while testing. Configure:
   - `WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_ENABLED=true`
   - `WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_CONTACT_ID=8863`
   - `WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_STARTS_AT=YYYY-MM-DDTHH:MM:SSZ` (actual UTC start of test)
   - `WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_EXPIRES_AT=YYYY-MM-DDTHH:MM:SSZ` (after start, **no more than 60 minutes later**)
3. After **separate explicit authorization accepting possible paid WhatsApp service-message charges**, enable only the existing reviewed secondary AI TEXT-only requirements, including live receiver, correct secondary token, receipt ingress, policy, billing reservations, manual reconciliation, `WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED=true`, `WHATSAPP_SECONDARY_AI_SEND_ENABLED=true`, `WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=true`, and prior approved shared clinic content. The original erased send is still UNKNOWN/UNKNOWN and must never be retried. Keep `WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED`, `WHATSAPP_SECONDARY_STAFF_SEND_ENABLED`, `WHATSAPP_SECONDARY_AI_MEDIA_ENABLED`, `WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED`, `WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED`, `WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED` and every other outbound feature **OFF**.
4. The owner sends a fresh **text-only** question from their personal WhatsApp. Verify exactly one reply arrives in the WhatsApp app, one outbound record belongs to sender 2, matched signed status/delivery and billing receipts, no new billing alarm, and zero unwanted primary/other-secondary sends. A Meta acceptance ID by itself is not verified delivery. The secondary messaging account currently has **no payment method**, so a blocked Meta delivery is possible.
5. **Stop immediately** on unexpected charge, missing delivery receipt, duplicate send, unexpected contact or any new billing alarm. Do not retry unknown sends.

## Rollback and eventual Ads-Only launch

- Immediately disable secondary AI and `WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_ENABLED`. The one-hour expiry also cuts off test authorization automatically.
- When an independent production launch is approved, remove the temporary test settings, switch to `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=ads_only` with the immutable **real launch UTC instant** in `WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT` (do **not** backdate), then separately activate approved features. Existing/direct/imported secondary chats, including contact 8863, remain manual.
- Do not enable media, 2h/6h/20h follow-ups or 48h/72h marketing through this test. The known personalized 20h function-name mismatch must be fixed before that feature is considered.

**No Render environment edits, Meta messages, production database changes, billing acknowledgments or live provider tests were made by this PR.**
