# Neutro Sense follow-up sequence (Oct 2026)

## Live clinic configuration
The Neutro Sense Neon `clinic_config.data.automatedFollowUp` was updated separately to:
- 2h after last reply: AI personal concern check-in; no unsolicited prices or media.
- 6h: AI explanation about appropriate assessment, followed by gentle booking invitation; no video.
- About 20h before WhatsApp 24h window closes: AI skips unless the lead has meaningful unresolved interest, otherwise short appointment invitation; NO existing testimonial video.
- Extended WhatsApp ad leads: prepared slots `[36,48,66]` measured **from the first qualifying business reply**, not from the last customer message. Not activated by this PR.
- 36h: `ns_pelvis_followup_video` (existing first pelvic video); for facial services `ns_fu1_service_checkin`; for other interests `ns_fu2_general_checkin`.
- 48h: `ns_fu3_pelvis_feedback` (second pelvic video) or `ns_fu3_face_feedback` (facial video); for other known services `ns_fu1_service_checkin`.
- 66h: `ns_enquiry_reengagement` gentle appointment invitation for eligible, interested leads only.
- Price/meridian promotional templates intentionally excluded from the sequence. The separate pricing reminder remains disabled.
- Consent request, appointment/staff exclusions, quiet hours 00:00–07:00, five-hour spacing, provider billing checks and max three unique extended templates are unchanged.

## This PR's safety improvements
1. Do not resend videos already sent in *any* outbound message for the current ad conversation; recheck the DB before dispatch to catch intervening manual sends.
2. Honor customer's language; accept previously approved Meta English video templates with locale `en` when customer locale is `en_US`. For Malay where videos lack a compatible approved language, use a distinct approved text-only template or skip. No silent Chinese fallback for English/Malay.
3. Skip 48h/66h reminders for cold or unidentifiable treatment enquiries; skip entire extended sequence for explicit deferral (e.g. “can I confirm tomorrow?”). Existing opt-out and eligibility gates remain.
4. Preserve approved-only templates and never generate arbitrary post-24-hour text. AI is only used while a customer-service window is open.

## Activation after merge
1. Confirm successful GitHub CI and Render deployment.
2. In Tools > Automated follow-up > WhatsApp ad leads, verify `36,48,66`, mappings and correct clinic assets, then enable. The UI writes a fresh `activatedAt` so older leads are not retroactively followed.
3. On Render set `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true`; **keep** `WHATSAPP_FEP_7DAY_VERIFIED=false` until a verified post-72h non-billable controlled test exists. Do not enable `whatsappFreeOnly` globally without assessing its effects on ordinary replies.
4. Monitor `whatsapp_free_entry_followup_attempts` and `whatsapp_free_entry_pricing_evidence` daily after activation; inspect Meta Billing Hub for any billable sends. Marketing templates are not guaranteed free.
5. The media templates used for pelvic/facial testimonials should have pre-approved video header assets in R2 and `videoCodecVerified=true`.
6. A fresh Meta approval would be needed for new human-sounding 36h/66h text. This rollout intentionally reuses **existing** approved templates. Other-services AI text after 24h is **not** possible unless a customer replies and reopens the 24-hour window.

## Manual checks
- Verify one eligible Chinese pelvis lead gets first video at 36h and different video at 48h; another with manual first video gets a distinct text fallback instead of duplicate.
- Verify English `en` video template is selected for English customer; Malay customer gets valid Malay fallback or is skipped.
- Verify no 66h send for cold, declined, deferred, booked, opted-out or staff-handled contacts.
- Verify no send at/after expiry minus one hour, no sends during 00:00–07:00, and no retroactive backfill.
