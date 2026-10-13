# Reusable WhatsApp follow-up video upload cache

Feature flag: `WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED=true` (default off).

## Scope and safety

- Only WhatsApp videos whose R2 keys pass `isSharedFollowUpConfigKey` are eligible.
- Other images, voice notes, manually uploaded and contact-specific videos, Facebook/Instagram, and Inbox direct-R2 playback are unchanged.
- Each lookup verifies the R2 object ETag, size and MIME and hashes its key/version with SHA-256. Neon stores that fingerprint, the sending WhatsApp phone-number ID, Meta media ID and expiration, but **no patient details, media bytes, object keys, token or signed URL**.
- A Media ID is cached for at most 25 days, shorter than the typical 30-day expiry of uploaded WhatsApp media. Changing the object version or sending phone number creates a separate entry.
- Database claims expire after 90 seconds. An in-process single-flight and DB claim reduce duplicate uploads, but if another uploader is stuck, the original upload path remains available.
- The policy check, pre-send cancellation, `whatsapp.sendVideoById` Strict RM0 reservation, follow-up scheduling, provider-message tracking and delivery-status webhook stay authoritative.
- If Meta unambiguously rejects a cached media ID as invalid, invalidate the cache entry **for future eligible sends only**. Never retry the same message after an unknown or timed-out send.
- The feature is optional. If the cache database is unavailable or the feature is disabled, the original R2 download -> WhatsApp upload -> send path remains.

## Safe rollout

1. Review/merge PR, leave feature OFF; migration `071_whatsapp_shared_video_media_cache.sql` is additive.
2. Confirm the new schema migration completed for Neutro before changing the flag.
3. Enable `WHATSAPP_VIDEO_MEDIA_CACHE_ENABLED=true` only on the Neutro Render service.
4. Run controlled **eligible**, consented test follow-ups on an approved test contact. First usage uploads to Meta; later usage reuses the ID. Check actual delivery via webhook, not just API acceptance.
5. Verify Strict RM0 blocks remain respected. Check there are no duplicate follow-ups, that the before/after images and captions remain correct, and that Render bandwidth changes align with video volume.
6. If problems occur, set the flag back to `false`. Do not reset Strict RM0 or broaden the free-message window.

## Out of scope

This does not affect R2 bucket public access or branding URLs; those require a separately reviewed security migration.
