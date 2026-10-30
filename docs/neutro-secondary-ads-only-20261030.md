# Neutro secondary WhatsApp: Ads-Only AI Mode
**Status: GitHub preparation only. Nothing deployed, switched on, or sent.**

## Goal and default
For sender `neutro_secondary` (中医养生馆), allow AI and automation **only** for genuinely new contacts arriving from Meta Click-to-WhatsApp ads after an explicitly chosen launch cutoff. Imported and existing chats always remain staff-managed, including if the contact clicks an ad later. Direct, QR, unknown-source and pre-cutoff contacts also remain staff-managed. The primary Neutro WhatsApp, Facebook Messenger and Instagram are not restricted by this audience rule.

## Qualification, based on durable provider evidence
- Secondary sender's active WABA/phone-bound conversation and contact.
- Contact creation and FIRST customer message both on or after the immutable UTC activation cutoff.
- FIRST saved provider customer message has an actual Meta ad referral record (`whatsapp_free_entry_referrals`, source_type=ad, with `ctwa_clid` or `meta_ad_id`), joined through the exact sender conversation.
- No earlier message at all, no imported coexistence history, no permanent Business App import marker, and the original Meta message timestamp after the launch cutoff. A later ad click **never** qualifies an old contact.
- Unavailable database, invalid UTC cutoff, disabled audience, or mismatched sender: fail closed.

Implementation reuses the existing referral table, sender context and receipt/billing gates. A forward-only schema migration (#110) marks Business App imported contacts permanently manual, including contact-only sync with no historical message. No new service, background polling, or outbound permissions.

## Applied safeguards
- Inbound message processing: manual Inbox for nonqualifying contacts; no AI reply, temperature classifier, transcription, pricing/result selection or automated handoff for those contacts.
- Background AI scoring/conversation summary: sender-only query filter and a second contact check before claim and before writing the score.
- Secondary 2h/6h/20h follow-up worker: query filter and before-send rule recheck.
- Secondary promo/result image worker: pre-enqueue, pending-job and claimed-job filters.
- Secondary provider dispatch: automated origins only (`ai_reply`, `system_fallback`, `ai_media`, `followup`) checked before billing and again immediately before provider send. Staff-only sends remain governed by existing staff authorization and safety.
- Passive inbound/Inbox and manual Business App access continue. Nonqualifying contacts get a quiet Inbox attention indicator, not a repeat AI-review alert.

## Supervised activation: NOT authorized by merge
1. Complete separate Phase A signed receipt and billing/reconciliation blockers, including the unresolved historical secondary send. Confirm current Render commit and successful primary WhatsApp/Messenger operation.
2. Deploy this PR with all secondary sending still OFF. Verify history and direct contacts have no AI jobs or automatic sends.
3. Set `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=ads_only` and `WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT=YYYY-MM-DDTHH:MM:SSZ` to the actual future supervised launch instant. Do not backdate; never change cutoff on later deployments.
4. After explicit live-send approval and independent sender billing/consent checks, enable only the previously reviewed secondary AI feature flags. Confirm one NEW CTWA contact gets one text reply and signed billing/delivery receipt. Confirm preexisting, imported, organic and ambiguous-source contacts get zero AI replies.
5. Extend follow-ups, media and templates one at a time, with separate approvals. Marketing templates still require independent Meta APPROVED status, exact scoped marketing consent and paid message authorization.

**Important:** PR #446 merged into main on 2026-10-30. PR #447 now integrates and gates its 20h personalization and 48h/72h marketing-template worker with the same first-ad rule, including the paid marketing dispatch origin. Post-24h sends still require exact approved templates, explicit consent, receipts and independent billing authorization.

The Inbox list/detail now reports per-contact secondary AI enabled only for qualifying new ad contacts, with a single batched eligibility query for the list. The Tools UI audience selector itself is still not implemented: activation requires explicit Render deployment-time settings.
