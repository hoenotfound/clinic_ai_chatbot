# PR395 relay deadline and replay guard (stacked, review only)

**Do not deploy, merge PR395, change a Meta callback, activate the QA receiver, or scan a QR based on these tests.**

The protected synthetic [relay rehearsal run #40489411845](https://github.com/hoenotfound/clinic_ai_chatbot/actions/runs/40489411845) passed 8/8 tests. It also demonstrated that the current relay's hardcoded `AbortSignal.timeout(8000)` may return a retryable HTTP 503 after a receiver has already committed an event. On Render Free, waking a sleeping receiver can exceed 8 seconds.

## Targeted adjustment

- Replace the 8-second **per-downstream** POST timeout with a 30-second **single total deadline** for the whole forwarded batch. An individual HTTP POST receives only the time remaining, never a fresh budget after previous deliveries.
- If the shared deadline expires before initiating a later POST, make no further downstream delivery attempt; return retryable HTTP 503.
- If a downstream POST times out after a possible commit or supplies a late HTTP 200 after expiry, treat its outcome as **unknown**, return 503, and **never retry it from within the relay**.
- Preserve strict HMAC validation, fixed known-WABA routing, signed downstream forwarding, and required durable ACK headers for lifecycle/preidentity events. Preserve fail-closed handling for unknown or incorrect receivers.
- Keep timeout injection **test-only** through `createRelayServer(config,{dispatchTimeoutMs})` / `dispatchSignedBatch(...,{dispatchTimeoutMs})`; no new production environment switch and no new polling, scheduled wake-up, automatic delivery retries, HTTP listeners, DB tables, or external services.
- The 30-second deadline is a strict upper bound in the relay implementation, **not a promise that Meta will hold the HTTP connection open for 30 seconds**. If Meta times out first, replay must be handled by durable downstream idempotency.

## What this does NOT prove or solve

- Upstream Meta/Render proxy timeouts, worker capacity, cold-start duration exceeding 30 seconds, and HTTP client disconnects are **not proven resolved**. Fast provider acknowledgments require always-ready receiving infrastructure or a verified durable-queue/ingress design; do not blindly increase timeouts further.
- A valid response to a partially delivered mixed webhook requires **durable provider-ID/fingerprint idempotency at every destination**. Legacy message/event paths need signed live-provider replay acceptance, not just mock-set deduplication.
- This change does **not** alter Meta callbacks or the currently inert relay preparation service. It must not be deployed as an active default callback without separate provider and operational tests.
- The existing protected manual workflow on `main` pins the old PR395 SHA and specifically measures the **old 8-second behavior**. After the target PR395 head is separately updated, a **separate workflow update/rehearsal** must re-pin the new exact SHA and adjust the timeout scenario. Do not repurpose the old green badge as evidence for the revised relay.

## Acceptance checklist

- New `test/pr395RelayDeadline.test.js` regression tests: signed mixed routing, deduplication on explicit replay, shared budget, timeout after simulated commit, absent durable ACK, legacy failure, invalid timeouts, foreign WABA and ignored AbortSignal.
- Existing relay unit and localhost integration tests pass.
- All PR CI jobs green on the **exact stacked-PR head**.
- Independently review the PR diff and confirm no files outside relay implementation, tests, and this note changed.
- Keep Neutro Render Auto-Deploy OFF. Only consider merging the small stacked PR into PR395's feature branch after explicit owner approval; **do not merge PR395 to main or enable Meta delivery**.
