# Neutro Render bandwidth investigation (16 November 2026)

## Read-only production evidence

- Render service srv-daqd1rp42hec7398itr0 recorded about 435 MB outbound bandwidth on November 15 (UTC), compared with 377 MB on November 14 and 641 MB on November 12. Approximately 4.16 GB was recorded over November 1–15.
- The existing five-minute app diagnostic snapshots on November 15 measured about 20 MiB of declared HTTP responses, and about 2.6 MiB of known Meta media and R2 outbound uploads. These are NOT complete wire counters. The remaining bytes may include streaming bodies, WebSockets and service-initiated traffic.
- Neon read-only video cache statistics on November 15 report nine secondary cache hits, zero uploads and approximately 122.7 MiB of estimated uploads avoided. Required migrations 071 and 132 are present. Do not disable the working cache.
- The Neutro R2 bucket CORS now permits both the existing Render origin and https://neutrosense.dasmarketingsolution.com, with GET, HEAD and Range unchanged. No bucket public policy or customer media changed.

## This diagnostic-only code change

An optional fixed-category body-byte counter piggybacks on DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED. It measures bytes passed to Express res.write and res.end, including long-lived SSE/chunked responses that do not finish within the measurement window. The counters reset in the existing five-minute snapshot. No raw path, patient identifier, media key, body, URL or credential is logged.

The new observedBodyMiB is app-attempted payload bytes, not Render-billed wire bytes. It can differ due to compression, TLS, aborted connections, WebSockets, third-party calls and platform traffic. The existing knownResponseMiB is unchanged. There are no new timers, network requests, media sends or DB queries.

## Safety and rollout

1. Run node --test test/neutroTrafficDiagnostics.test.js test/inboxDirectR2Video.test.js test/inboxDirectR2VideoRoute.test.js plus standard CI and review the write/end forwarding and media/SSE regression coverage.
2. Render auto-deploy is OFF. Do not deploy without reviewed CI and one controlled release. Do not change sender, R2 delivery, staff, opt-out, billing or follow-up flags.
3. Observe one full comparable business day, aggregate observedBodyMiB by category, and compare to Render Outbound Bandwidth by traffic source: HTTP Responses, WebSocket Responses, Service-Initiated and PrivateLink as applicable.
4. If service-initiated dominates, investigate outbound provider calls. If HTTP responses dominate, focus on high-volume response categories. Do not change message schedules or media authorization based on incomplete byte estimates.
5. If a regression occurs, revert this diagnostic code and deploy deliberately once. No data or schema rollback is needed.
