# Neutro secondary WhatsApp bandwidth reduction (5 November 2026)

## Why this change
Render's 1–4 November service bandwidth increased from about 148 MB/day on 1–2 November to 345 MB on 3 November and 316 MB on 4 November (UTC). The secondary sender logged 18 follow-up videos on 4 November using four distinct source files. Prior to this change the secondary worker downloaded each R2 MP4 and uploaded the whole file to Meta once **per recipient**, while the primary WhatsApp used an existing 25-day reusable Meta upload cache.

The Render dashboard's service-initiated bucket includes all app outbound connections. This change removes redundant video payload transfers but cannot prove that all Render traffic is video uploads.

## Implementation and rollout

- `WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED=false` by default. Enable only in the Neutro Render service after the PR has been reviewed, merged, deployed **once**, and the existing video cache table (migration 071) is verified.
- Cache keys include the secondary Meta **phone-number ID** and the R2 object's key/ETag/size/MIME fingerprint. A primary phone's media IDs are never used on the secondary number. Cache records contain no patient identifiers, object keys or media bytes.
- Only approved shared clinic follow-up videos pass the secondary guard. Unverified, revoked, contact-specific or unsupported media keep their old policy. The approval check is performed before and immediately after any cache lookup or upload.
- The existing sender-specific one-shot follow-up attempt, fresh audience check, booking/opt-out/staff handoff checks, billing reservation, transport verification and delivery receipt remain unchanged.
- A cached Meta ID is reused only to deliver **one newly authorized message**. An ambiguous response is never automatically resent. An expired cached ID is refreshed when expired in storage (25-day TTL). If Meta **definitely** rejects a cached media ID as invalid, invalidate the entry but do not resend the current one-shot attempt.
- A cache outage or non-cacheable shared asset falls back to the existing per-recipient upload without bypassing message checks. A failed/unknown upload response does not get an immediate second upload.
- Rollback: set `WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED=false` and perform a single deliberate deployment if necessary. Data from the existing table can safely remain.

### Suggested release verification

1. Confirm live Neutro sender mapping matches two distinct Meta phone IDs and migration 071 exists; do not copy any cached Meta IDs between phones.
2. Run targeted Node tests, then CI once for the PR. Do not deploy on each commit.
3. On a dedicated consented secondary ad test contact, send one **due** approved 2h/6h follow-up using the existing one-shot mechanism. Confirm the provider receipt and that the media matches the selected treatment.
4. On a later eligible *different* test conversation, verify the same clip uses a cache hit and no new Meta upload. Never manually re-run an already attempted follow-up.
5. Verify opt-outs, bookings, staff takeover and unconfirmed treatment selection still block follow-ups. Compare daily per-phone stats:

```sql
SELECT event_day, phone_number_id, cache_hits, cache_misses, uploads,
       fallbacks, invalid_ids, recovered_sends,
       ROUND(upload_bytes_avoided / 1048576.0, 2) AS estimated_mb_avoided
FROM whatsapp_video_media_cache_daily_stats
WHERE event_day >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY event_day DESC, phone_number_id;
```

## Outbound payload measurements

Set `DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED=true` on the Neutro service for a short observation period. The existing memory-diagnostics timer emits one compact `[Outbound payload diagnostics]` JSON line every five minutes. No new timers, external calls, database queries or stored telemetry are created.

Three counters estimate **attempted upload payload bytes**, not actual Render-billed bandwidth:

- `meta_primary_media`: body file bytes sent to Meta by primary WhatsApp media-upload calls.
- `meta_secondary_media`: body file bytes sent to Meta by sender-verified secondary transport.
- `r2_object_upload`: body file bytes sent by the application's R2 PutObject calls.

These exclude multipart overhead, TCP/TLS, database traffic, AI/Telegram HTTP calls, R2 GETs (incoming to Render), and R2's internal object copies. The counters are directionally useful for finding the large-video sources; do **not** treat them as a billable Render breakdown. Zero requests in a five-minute period produce zeros. The log contains no URLs, phones, media IDs, keys, tokens, or message content.

Compare these five-minute upload figures with Render's hourly bandwidth metrics over similar traffic periods. Do not assume that eliminating Meta uploads alone will eliminate the entire service-initiated baseline.

## Video compression review

Historical primary cache stats suggest common follow-up clips are roughly 12–14 MiB each. A reused Meta media ID saves virtually the whole upload even without re-encoding.

For *new* clinic-approved videos, a separately reviewed H.264/AAC MP4 at 720p, around 24–30 fps, and a sensible bitrate may lower storage and first-upload bytes. Use a visual and caption/audio quality check before replacing configured assets, and preserve the R2 version/ETag-based cache invalidation. No automatic transcoding is introduced here: it would change customer-facing quality and consume CPU/RAM on the 512-MB Render instance.
