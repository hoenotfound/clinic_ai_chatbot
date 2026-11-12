# Neutro secondary WhatsApp: legacy staff mode and ad re-entry

Date: 12 November 2026

## Client decisions

1. Staff replying in WhatsApp Business App does **not** automatically end a follow-up sequence. The AI may follow up after an appropriate quiet period, with staff question, booking, safety, opt-out and human takeover safeguards.
2. Historical customers remain **staff-managed** for ordinary/direct messages. Existing records and manual staff takeovers are not bulk modified. Inbox uses an effective Staff label while AI is ineligible.
3. A historical customer who sends a **fresh, sender-bound CTWA ad referral** may re-enter AI and follow-up for seven days. A real Meta ad ID or CTWA click ID is needed, from the current sender-specific conversation. This is not an advertising attribution guess based on the message wording.
4. For unreadable Meta 131060 messages, if the **same signed inbound** has a verified CTWA ad referral, a single tracked neutral treatment-selection menu is permitted even for returning customers. A subsequent readable response or genuine button selection starts normal AI response and service follow-up eligibility. The placeholder itself never triggers media or follow-ups.

## Guardrails

- Old contacts with no new ad referral do not receive AI or automatic follow-ups, even if the database originally stored `mode='ai'`.
- `mode='human'` explicit takeover remains human even if a new ad is received. Existing contacts are not mass-updated and staff handoff history is retained.
- No customer can be sent more than one recovery menu for one inbound job. A staff message or readable customer reply before the recovery send cancels the menu.
- No customer opt-out, booking/clinical hold, unverified sender, unknown provider receipt or aged WhatsApp service window may be bypassed.
- Marketing templates continue to require an approved template, exact treatment-specific marketing consent, billing authorization and the existing one-shot safeguards. Clicking an ad does not automatically create marketing opt-in.
- Without text *and* without signed Meta ad referral data, 131060 cannot establish that an old contact clicked an ad. Staff must handle it or wait for a later genuine readable/ad-attributed inbound. No fabricated attribution, inferred advertising source or unsolicited recovery to old direct contacts.
- The automatic eligibility window is seven days from a verified ad entry. A 24-hour customer-service reply window is measured from the customer inbound, never from the staff reply.

## Activation (after PR review, CI, merge and controlled Render deployment)

1. Keep existing `WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE=all_contacts` and `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=all_contacts`, because the new rule **narrows** both audiences. Do not change the primary number.
2. Pick and record a fresh UTC cutover timestamp, then set `WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED=true` and `WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT=<UTC ISO timestamp>`. A malformed timestamp fails closed, and Render needs a fresh process to rebuild the worker SQL.
3. Confirm the existing 131060 recovery flag/timestamp remain properly enabled if that recovery is desired. Do not re-date earlier events or backfill skipped sends.
4. Test four fresh cases on the secondary sender: old contact direct text (staff only); old contact with verified readable ad (AI and follow-up); new ad with verified Meta 131060 (one recovery menu, button resumes AI); old 131060 without ad metadata (no automated message).
5. Review new attempt records, Meta delivery receipts and exact marketing consent before broader use. Do not auto-replay unknown or historical attempts.

To pause the new policy, disable `WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED` and redeploy. **That restores the prior broad all-contact audience** if the old settings are unchanged. To maintain staff-only operation, do not disable this switch without arranging an alternative audience restriction.

## Release boundaries

Draft PR only. No production SQL writes, template sends, blasts, environment changes or deployment.
