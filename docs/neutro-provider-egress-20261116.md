# Neutro service-initiated traffic diagnostics (16 Nov 2026)

## Evidence and why

- The owner-provided Render workspace Billing screenshot shows 4.12 GB / 5 GB included bandwidth: Service-Initiated 3.69 GB, HTTP Responses 440 MB, WebSocket 0 MB, Private Link 0 MB. This is a **workspace-wide monthly** snapshot, not a Neutro-specific category chart. Previous per-service read-only Render metrics indicated Neutro accounts for the overwhelming majority of the workspace total.
- Existing upload counters show that known Meta and R2 uploads do not account for the workspace service-initiated total. Neon project data_transfer_bytes is a Neon metric and cannot be directly equated to Render outgoing bytes.
- PR #643 already added HTTP res.write/res.end measurements. These cannot by themselves attribute service-initiated traffic.

## This change

- Add passive Node diagnostics_channel observers for native Node HTTP and undici client connection events, and passive PostgreSQL pool connection tracking.
- On the existing five-minute memory-diagnostics tick, sample **socket.bytesWritten** deltas by six fixed destination groups: neon, meta, gemini, r2, telegram, other. Count HTTP request starts and new sockets, but do not log any hostname, raw URI/path, headers, source buffer, credentials, query, contact, message, customer, media key, or patient data.
- Enabled only when the existing DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED flag is true; no new environment variables, timers, SQL, requests, retries, media sends, polling or database wakes. No change to the network socket's write methods or request options.
- The records are coarse estimates, **not** byte-perfect provider invoices or billed Render egress. TLS and HTTP overhead, preexisting warm sockets, client libraries using other transports, proxying, and Node's socket byte semantics may cause missing or different counts. The other bucket is not proof of malicious traffic. Never treat a zero as confirmation of zero activity.
- All active sockets are tracked in a bounded in-memory map (up to 512) and released on close; activity beyond the cap is counted only as untracked sockets.

## Rollout and verification

1. Run node --test test/outboundNetworkDiagnostics.test.js test/memoryDiagnosticsService.test.js test/neutroTrafficDiagnostics.test.js plus CI. Independently check that customer sends, permissions, Meta callbacks, pricing and follow-ups are untouched.
2. Deploy Neutro once after tests. Keep auto-deploy disabled and do not change any business, pricing or video flags.
3. Inspect the logs for [Outbound network diagnostics] each five minutes. Sum outboundMiB for comparable local-hour periods; compare against per-service Render bandwidth usage and workspace Service-Initiated category. Check complete 24-hour samples before concluding savings or a dominant destination.
4. If Meta dominates, investigate known media uploads vs other Graph requests without replaying customer sends. If Neon dominates, inspect query and pool sources before any index or SQL changes. If Gemini dominates, review prompt payload and retries without reducing answer quality. If R2 dominates, review large PUT operations and object sizes. If other dominates, identify the missing transport instead of automatically blocking endpoints.
5. Revert instrumentation if diagnostics affect throughput, errors or stability. No migration or customer data rollback is required.
