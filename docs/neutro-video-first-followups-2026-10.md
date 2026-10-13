# Neutro Sense: video-first follow-up rollout

Clinic: Neutro Sense TCM. Production Neon `clinic_config.data.automatedFollowUp` is configured independently.

## Schedule
- **2 hours from business reply**: treatment explanation video, with a short treatment-specific Chinese/English/Malay caption when a verified matching asset exists. Currently the existing first pelvic explainer is mapped for `骨盆调理` and `徒手体态调理`. For 3D/9D and other services, the configuration falls back to an AI explanation **without video** until actual explanation videos are uploaded; never mislabel testimonial material as explanation footage.
- **6 hours**: existing pelvic experience video or distinct 3D/9D/combination customer experience video, with a short, reviewed caption. The AI runs its safety skip/review logic but the configured media caption remains fixed. For an unavailable matching video, use a natural AI trust-building text without media.
- **20 hours** (selective, before 24h expiry): AI personal check-in, inviting a complimentary one-on-one body assessment when suitable for pelvic/posture enquiries. Trial treatment isn't described as free; for facial enquiries invite a relevant facial consultation. No repeated videos, prices or unverifiable claims.
- **48 hours from first qualifying business reply**: approved WhatsApp MARKETING template `ns_enquiry_reengagement` inviting assessment (only qualifying consented CTWA WhatsApp contacts).
- **66 hours**: distinct approved `ns_fu2_general_checkin` reminder, then stop extended auto-template sequence. Do not schedule 72h at the free-entry billing cutoff.

## Activation and risk safeguards
- 2h/6h/20h enabled in DB for conversations from the new activation timestamp.
- Post-window `freeEntry.enabled=false` until after PR merge, deployment and review. `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` on Render is necessary but **insufficient** by itself; the Tools clinic switch must be enabled too.
- Keep `WHATSAPP_FEP_7DAY_VERIFIED=false`; both 48h and 66h stages are below the conservative 72h deadline, with a safety buffer. The initial paid CTWA activation callback and subsequent Meta billing determine actual costs; never promise zero charges.
- Clinic quiet hours 00:00-07:00, consent, opted-out, staff takeover, follow-up spacing, booking, patient deferral, clinical concerns and template approval safeguards are preserved.
- The new repo utility prevents sending the **same stored R2 video** twice in seven days if staff or another follow-up already shared it; rechecks before provider send. It is enabled specifically for Neutro through `videoDuplicateProtectionEnabled=true` in Neon and preserved on ordinary Tools saves; other clinic instances retain their current behavior.
- New treatment-explanation assets for 3D, 9D and 3D+9D must be uploaded and explicitly assigned to the first step to meet the video requirement in full.
- Current approved text templates provide useful general appointment and check-in messages; fully personalized per-concern post-window wording requires separately approved Meta template variants.

## Validation
- PR includes regression tests for duplicate-media checks.
- Verify one pelvis and one facial chat from fresh contact enquiries; do not backfill older conversations.
- Confirm rendered 6h testimonial doesn't get repeated by staff, extended template worker or the same in-window sequence.
- Confirm the exact copied media assets in the clinic UI and the app's runtime-loaded config after deployment.
