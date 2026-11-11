# Neutrosense Render public-route traffic guard (11 November 2026)

## Reason for change

Render measured approximately 1,882 MB of Neutrosense outbound bandwidth during 1–10 November 2026 (UTC). The 10 November 08:00 UTC bucket reached 59.7 MB. The app's existing five-minute diagnostics showed approximately 1,659 responses in the coarse `other` category over 08:00–10:00 UTC, including 768 responses with unknown Content-Length. Measured Meta media and R2 uploads in this period were less than 1 MB.

This is **not** proof that the 1,659 requests were all bots. The old coarse category included valid `/meta-webhook` and `/promo-images/:id` responses as well as arbitrary routes. And the diagnostics count declared Content-Length, **not Render-billed outbound bytes**. Health was similarly overbroad: `/health/anything` was grouped with the real health endpoints.

## Change

1. The React HTML fallback now serves only the public staff-page paths declared in `portal-frontend/src/App.jsx`. Unknown GET/HEAD paths return a small 404; more than 40 unknown routes from the same source within a five-minute window receive a small 429 with Retry-After. Sources are keyed in a bounded in-memory map by an ephemeral HMAC, with no source identifiers or request paths in logs. **Normal staff pages are never rate limited**, regardless of whether the same client also requested invalid routes.
2. Diagnostic buckets distinguish `meta_webhook`, `promo_images`, `portal_page`, `health` (only the three configured endpoints), `unknown_health`, `static` and `unknown_path`. Unknown responses now include 404 and 429 totals. They remain fixed-label aggregate snapshots.
3. Request order is unchanged: readiness handling, signed WhatsApp/Meta webhook routes, public promotional images, authenticated staff APIs and actual built static files are resolved *before* this fallback. Root `/` and `/health/live` / `/health/ready` still return original health responses.

## Safety limits

- No media delivery, AI, message billing, scheduler, opt-in, opt-out, staff handoff, or query changes.
- No environment variables, production data, credentials or database schema changes.
- The limiter does not block authenticated APIs, signed Meta/WhatsApp webhooks, media/image delivery, valid React deep links, or Render's root health check.
- Per-process memory cap of 1,024 hashed source entries, with entries expiring after five minutes. No database reads, timers or external calls.
- Do not infer that all previous `other` traffic was malicious; compare the new fixed route categories after rollout.

## Verification and rollback

Before merge, run `node --test test/portalFallbackGuard.test.js test/neutroTrafficDiagnostics.test.js test/serverCompositionGuard.test.js` plus standard CI. Verify these URLs manually on staging with staff credentials: `/login`, `/inbox`, `/settings/advanced-config`, and `/tools/lead-distribution`. Verify `/`, `/health/live`, and `/health/ready` still return normal responses. Verify the Meta webhook challenge and signed webhook delivery with safe test traffic. Verify `/promo-images/:id` and a real static JS asset continue to work.

After a single approved Neutrosense deployment, compare each new diagnostic category by five-minute window with Render hourly usage, 200/304/302/404/429/503 responses, and R2/Meta media counters. Ensure staff login, Inbox, AI replies, promotions, secondary WhatsApp callbacks and follow-ups still work. The observed traffic pattern may change after rollout; measure at least a comparable full business day before claiming savings.

Rollback by reverting the PR and deploying Neutrosense once. The guard is self-contained and requires no schema rollback.
