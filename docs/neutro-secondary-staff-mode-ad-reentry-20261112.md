# Neutro secondary WhatsApp: legacy staff mode and ad re-entry

Date: 12 November 2026

## Client decisions

1. Staff replying in WhatsApp Business App does **not** automatically end a follow-up sequence. The AI may follow up after an appropriate quiet period, with staff question, booking, safety, opt-out and human takeover safeguards.
2. Historical customers remain **AI paused** for ordinary/direct messages unless another qualifying recovery path applies. Existing records and actual manual staff takeovers are not bulk modified. Inbox no longer calls a policy pause a staff takeover.
3. A historical customer who sends a **fresh, sender-bound CTWA ad referral** may re-enter AI and follow-up for seven days. A real Meta ad ID or CTWA click ID is needed, from the current sender-specific conversation. This is not an advertising attribution guess based on the message wording.
4. A recent **verified CTWA ad received before the staff-mode cutover** can also qualify a historical customer, but only after a NEW readable sender-bound customer message received after cutover and within seven days of that original ad. The old ad or an unsupported placeholder alone never authorizes a reply or a new follow-up anchor.
5. A genuine Meta 131060 error on the secondary number may send one tracked neutral treatment-selection menu even when Meta omits the ad referral. A later readable customer reply restores normal AI replies and eligible follow-ups. The unreadable placeholder alone never triggers treatment media, sales follow-ups, or ad attribution.

## Guardrails

- Old contacts without a new verified ad or a **new readable follow-up to a verified ad from the previous seven days** do not receive AI or automatic follow-ups, even if the database originally stored `mode='ai'`. No old messages are replayed.
- `mode='human'` explicit takeover remains human even if a new ad is received. Existing contacts are not mass-updated and staff handoff history is retained.
- No customer can be sent more than one recovery menu for one inbound job. A staff message or readable customer reply before the recovery send cancels the menu.
- No customer opt-out, booking/clinical hold, unverified sender, unknown provider receipt or aged WhatsApp service window may be bypassed.
- Marketing templates continue to require an approved template, exact treatment-specific marketing consent, billing authorization and the existing one-shot safeguards. Clicking an ad does not automatically create marketing opt-in.
- A Meta 131060 with no readable text or referral cannot establish an ad click. The one-time neutral menu is a recovery exception, not advertising attribution or consent. Regular follow-ups require a later readable customer reply.
- The automatic eligibility window is seven days from a verified ad entry. A 24-hour customer-service reply window is measured from the customer inbound, never from the staff reply.

## Activation (after PR review, CI, merge and controlled Render deployment)

1. Keep existing `WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE=all_contacts` and `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=all_contacts`, because the new rule **narrows** both audiences. Do not change the primary number.
2. Pick and record a fresh UTC cutover timestamp, then set `WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED=true` and `WHATSAPP_SECONDARY_LEGACY_STAFF_ACTIVATED_AT=<UTC ISO timestamp>`. A malformed timestamp fails closed, and Render needs a fresh process to rebuild the worker SQL.
3. Confirm the existing 131060 recovery flag/timestamp remain properly enabled if that recovery is desired. Do not re-date earlier events or backfill skipped sends.
4. Test four fresh cases on the secondary sender: old contact direct text (staff only); old contact with verified readable ad (AI and follow-up); new ad with verified Meta 131060 (one recovery menu, button resumes AI); old 131060 without ad metadata (one safe recovery menu, with no follow-ups until the customer responds).
5. Review new attempt records, Meta delivery receipts and exact marketing consent before broader use. Do not auto-replay unknown or historical attempts.

To pause the new policy, disable `WHATSAPP_SECONDARY_LEGACY_STAFF_MODE_ENABLED` and redeploy. **That restores the prior broad all-contact audience** if the old settings are unchanged. To maintain staff-only operation, do not disable this switch without arranging an alternative audience restriction.

## Release boundaries

Draft PR only. No production SQL writes, template sends, blasts, environment changes or deployment.

## Inbox diagnosis clarification

- **AI active** means the contact is AI-owned and currently passes secondary audience checks. It is not a promise that a particular outgoing message can bypass provider billing, 24-hour freeform-window or consent restrictions.
- **AI paused** means an AI-owned contact has not passed secondary audience or sender gates. This is *not* an explicit staff takeover and may recover on a qualifying new message.
- **Staff takeover** is reserved for contacts explicitly owned by a staff member. AI-created, still-unclaimed handoffs appear as **Needs review**. Stored handoff records and deliberate takeovers are never bulk reset.
- **Needs review** identifies attention flags without labelling them as staff takeover.
- **Ad source unknown** identifies a recent Meta 131060 unreadable inbound without verified CTWA attribution. It is an investigation clue, not proof of an ad click, marketing permission, or eligibility.

A staff reply through the WhatsApp Business App must not by itself change an AI-owned contact into explicit `mode='human'`. This feature does not alter that existing behavior.

## Integration verification after PR #602

PR #602 updates pelvic/postpartum treatment selection and manual promotion-image duplicate detection. This UI and legacy-ad re-entry change does not widen treatment-specific marketing consent, change those pricing paths, or replay historical follow-ups. Re-run PR checks against the updated main branch before production deployment.

## Additional safety review

- The historical-ad re-entry path requires nonempty readable text and rejects all system-created attachment/unsupported-message placeholders. Imported history, other sender conversations and expired ad evidence cannot enable the new path.
- AI-created, unclaimed handoffs display **Needs review** while attention is open and **AI paused** after it is cleared. Neither state falsely implies staff took over or AI has resumed.
- **Ad source unverified** is an evidence-status hint, never proof of an ad click. Only matching retained inbound processing records can confirm Meta 131060; when provider evidence has been pruned the error code itself remains unverified.
- No retrospective messages, marketing-consent changes, bulk ownership resets, or deployment are included.
