# PR #395: protected localhost-only app-default relay rehearsal

**Status: PREVIOUS OLD-SHA REHEARSAL PASSED 8/8; RE-PIN AND UPDATED DEADLINE TESTS IN A NEW DRAFT PR. New-SHA rehearsal is NOT YET RUN. No QR, Meta callback change, Neutro production deployment, or PR #395 merge authorized.**

This is an **entirely synthetic test** of the exact reviewed relay implementation at PR #395 SHA `e1b0dc8f682477aec69f6afe671f81758f772f2b`. It cannot establish real Meta provider delivery, the list of authorized WABAs, live account disconnection alert coverage, production safety under a callback cutover, or a 24-hour history import.

## Scope

New manual workflow: `.github/workflows/pr395-isolated-default-relay.yml`

New Node built-in-only test harness: `scripts/qa/pr395LocalRelayRehearsal.cjs`

- The workflow uses `workflow_dispatch` **only**, `LOCAL_RELAY_ONLY` confirmation, and **main branch only**.
- Runs under the existing `pr395-isolated-webhook-rehearsal` GitHub environment with its human reviewer/main branch protections.
- It does **not reference the environment's HMAC secret** or any other secret. HMACs use a hardcoded, obviously synthetic test key only.
- The first-party checkout action is pinned to a commit. `persist-credentials: false`. The only GitHub permission is read-only source access.
- The workflow publicly fetches the PR #395 source from `refs/pull/395/head`, verifies its **exact SHA**, and extracts just `src/services/whatsappAppDefaultRelay.js` to runner temp. If the PR head has changed, the job **fails before executing PR code**. No PR checkout, dependencies or deployment.
- Every fake HTTPS destination ends in `.invalid`. A strict injected transport maps those exact URLs to ephemeral `127.0.0.1` Node HTTP mock receivers. Any other downstream URL is rejected. The real relay, its simulated legacy callback, legacy lifecycle audit, and secondary preidentity receiver all run in the GitHub runner; none can call Meta, Neutro or Render by the test's configured egress transport.
- Real Meta/WABA credentials, customer messages, private QA number and Neon DB access are **never** provided to this workflow. Fixtures use entirely synthetic account IDs, phones and messages.

## Scenarios tested

1. The preparation-mode relay returns healthy status but refuses callback verification and event POSTs.
2. In isolated bootstrap mode, signed GET challenge works; invalid challenge and invalid raw-body HMAC are rejected with no downstream work.
3. A signed **mixed synthetic** batch routes an ordinary legacy message to the legacy mock, a legacy `account_update` to the durable lifecycle audit mock with mandatory `X-DA-Legacy-Lifecycle-Accepted: 1`, and a separate new-account `account_update` to the preidentity mock with mandatory `X-DA-Coexistence-Preidentity-Accepted: 1`. Every mock verifies the forwarded HMAC.
4. Identical signed webhook replay is idempotent at all three mock receivers.
5. Unknown WABA customer messages, wrong or missing E.164, and secondary history landing at the app-default callback are refused without crossing a mock receiver.
6. A legacy audit receiver returning HTTP 200 **without durable acknowledgment** causes 503, and blocks later preidentity forwarding.
7. A preidentity receiver returning HTTP 200 **without durable acknowledgment** also causes 503.
8. Legacy downstream outage and simulated lifecycle database outage return 503; a subsequent **explicit synthetic provider replay** recovers without duplicate mock commits.
9. A slow legacy lifecycle receiver commits but responds after an injected **75ms total shared deadline**. The relay returns 503 within a bounded elapsed time, never falsely ACKs, and explicit synthetic Meta replay finishes without duplicate mock commits.
10. A deliberately never-settling downstream transport that **ignores AbortSignal** cannot keep the upstream HTTP connection blocked beyond the injected shared deadline; the relay returns 503, signals best-effort abort, and does not call later destinations.

The protected manual harness uses a test-only 75ms deadline to verify the new cancellation-independent enforcement quickly. The relay's default upper budget is 30 seconds; **this is not a guarantee that Meta will wait 30 seconds**. The previous protected old-SHA rehearsal passed 8/8 in [run #40489411845](https://github.com/hoenotfound/clinic_ai_chatbot/actions/runs/40489411845). The new **9-case** rehearsal must run separately after this workflow update is reviewed and merged.

## Important limitations and follow-up

- `createRelayServer` is tested against **localhost loopback mocks**, not the actual deployed Render relay (which intentionally remains inert) or real Meta-signed delivery.
- The replay test models durability with deduplicating memory sets. It does not substitute for actual Neon transactional or delayed-commit proof. The **separate existing signed staging/Neon rehearsal** verified single-record audit and has been cleaned up.
- A cold Render receiver or Meta's own webhook timeout may still expire before the new bounded 30-second total relay budget. Correct fail-closed and replay behavior is useful, but for real provider delivery we must prove downstream idempotency, callback-response timing, and cold-start-tolerant durable ingress **before** changing the Meta app-default callback.
- Full developer-app-scoped WABA account inventory (including delegated businesses) is not proven, QA's real WABA/phone IDs are not yet issued, QA inbound receiver/history importer is not provider-accepted, and signed Meta callback cutover/rollback remain unverified.
- **Never** set the Meta callback to the inert relay, scan the personal QA Business App QR, initiate `smb_app_data`, enable secondary sending, or merge PR #395 on the basis of these simulated test passes.
- **Neutro Auto-Deploy stays OFF** until a separate operator decision. The workflow-only PR must have its own review and CI, and should be squash-merged only with `[skip render]` in the actual commit message. The old green run is not evidence of the new relay behavior.
- GitHub only shows `Run workflow` for a manually triggered workflow once its YAML is present on the default branch. No merge and no manual run are automatic.

## Running after separate authorization (new SHA)

After the workflow-only PR's CI is green and approved, merge **only that workflow PR**, then open GitHub **Actions > PR395 isolated default-callback relay (local only) > Run workflow**, select `main`, type `LOCAL_RELAY_ONLY`, and complete the environment reviewer approval. Do not rerun using a stale pinned PR SHA if PR #395's head has moved.

The output should report all local cases passing. Verify PR #395 unchanged, current Meta callbacks unchanged and Neutro's production Render deployment unchanged afterward.
