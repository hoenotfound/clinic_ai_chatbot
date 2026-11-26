# Reply-authority rollout, 26 November 2026

Integration PR includes the exact #745 and #738 changes plus the first implementation tranche from the stages 6–11 audit. Do not independently squash the overlapping PRs without reconciling the combined branch.

Implemented:
- Stage 6: do not rewrite a noncommercial draft simply because of a repeated intro; do not force assessment invitations from pricing fallback. Keep real price authorization, amounts, package/offer conditions, free-assessment and conflict guards.
- Stage 7: independently check clinical risk before accepting a structured information classification. A practitioner title alone is not a medical question. A recorded staff review can receive a safe acknowledgement while remaining pending. Do not suppress a new medical disclosure or staff alert.
- Stage 8: reduce ordinary reply overrides through #745 and natural pricing fallbacks; no removal of untested clinical or price recovery branches.
- Stage 10: model-selected no_reply only for a verified delivered conversation ending with a pure social acknowledgement; unsafe or ambiguous cases continue using the model's fallback text.
- Stage 11: log validator labels, message/contact IDs, changed status and outcome; no message body or draft in these new logs. Unattributed changes are logged separately rather than silently assumed safe.

Not implemented in this tranche:
- A single structured price-claim renderer replacing all legacy comparison/price formatters, and retirement of the rapid pricing safeguard.
- Verified linkage/deduplication of additional clinical disclosures with an existing pending review. Do not suppress new clinical information without robust evidence.
- Stage 9: RM68 event dates and copy remain code-enforced. Moving their authoritative configuration to Neon requires a tested contract for expiry, event dates, first-reply and follow-up copy and separate ordinary-date care; do not merely duplicate the campaign into the general FAQ.
- Location/intro/language relaxation and remaining recovery function retirement require their own regression coverage. Current objective safety and factual checks are deliberately retained.
- Production deployment and monitoring are gated on full CI and review; syntax validation is not full runtime validation.

No migration, extra model call, worker, database polling or production configuration write in this integration PR. Existing promotional captions are not modified.
