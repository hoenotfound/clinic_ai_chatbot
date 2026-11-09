# Neutro traffic and follow-up performance review: 9 November 2026

## Production evidence before changes

- Render service `srv-daqd1rp42hec7398itr0`, Singapore: service bandwidth 122.7 MB on 6 Nov, 123.3 MB on 7 Nov, 183.9 MB on 8 Nov (UTC). 503 responses persisted daily, and recent Render log queries returned no complete request-path breakdown.
- Neon project `steep-forest-44509907`: November project network-transfer counter 1,130,638,706 bytes as of 9 Nov ~21:05 MYT. Free plan's project-consumption history endpoint is unavailable (403).
- `pg_stat_statements` reset 9 Nov at 12:55 UTC. After reset, sampled sender-owned 48h/66h marketing queries averaged roughly 12 to 13 seconds, with 9 calls. Historical table scan counters are cumulative and must not be treated as daily bandwidth.

## What this PR changes

1. A **necessary-only** five-day candidate shortlist for 48h/66h marketing follow-ups. The existing first-reply anchor is within 24h of inbound; 66h due time plus 8h grace + 24h reply delay = 98h worst case, safely inside five days. Day4/Day6 preserves the original nine-day window. An additional existence check for an opted-in marketing lead only excludes contacts that can never pass the later mandatory latest-lead marketing-consent check.
2. Lightweight fixed-label Express response counters. Count requests, 503s and the sum of **known declared Content-Length values** by route category. Chunked or compressed responses without a declared size are recorded as unknown. These counters do **not** represent complete Render-billed wire bytes, outbound uploads or Neon transfer.
3. Fixed-label direct-R2 Inbox MP4 result counters (redirect, disabled/proxy, unowned, invalid object, error), piggybacking on the existing five-minute outbound diagnostics snapshot. No requests, R2 accesses, SQL, or timers added by measurement itself.

No patient identifier, request path, media key, signed URL, HTTP header value, prompt, phone, response body or external destination is written to diagnostics. Existing R2 authorization, object HEAD checks, ten-minute signed links and fallback remain unchanged.

## Verification / deployment

- Run `node --test test/neutroTrafficDiagnostics.test.js test/inboxDirectR2Video.test.js test/whatsappSecondaryVideoCache.test.js` and relevant secondary follow-up tests, then standard CI.
- Do not merge on tests alone. Check candidate eligibility and timing for primary + secondary; confirm no duplicate sends, no opt-out / booking / staff-handoff bypass, and all Day4/Day6 rollout flags unchanged.
- Render has auto-deploy disabled. Deploy **once** after explicit approval.
- Confirm `DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED=true` for the observation period, without exposing values of other environment variables. Do not enable `INBOX_DIRECT_R2_VIDEO_ENABLED` solely to chase metrics. First verify R2 CORS, browser playback, staff permission checks and actual rollout flag from existing configuration.
- After deployment, compare 24h response category counts, unknown-length proportions, direct-R2 redirect/fallback outcomes and Render hourly 302/206/503/bandwidth. If Render 503 totals exceed app-level buckets, suspect proxy-level/uninstrumented errors rather than changing webhook retries speculatively.
- Compare same local-hour Neon project transfer snapshots a day apart. Reset of `pg_stat_statements` must not be mistaken for transfer savings; use fresh call/latency counters and query plans instead. If slow query persists, prepare a separately reviewed, targeted index/migration after live EXPLAIN, not an unverified schema change.
- To roll back, revert PR and deploy once. Counters are in-memory only, reset every five-minute snapshot.
