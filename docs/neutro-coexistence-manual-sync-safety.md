# Neutro second-number manual Coexistence sync safety

**Code-only preparation. QR NO-GO. Do not change production, Meta callback, or initiate a sync on the basis of this PR.**

## Why no pre-identity patient-data holding table

Meta's Coexistence onboarding flow supports an **operator-initiated, one-time** `POST /{verified PHONE_NUMBER_ID}/smb_app_data` request for `history` and a separate one for `smb_app_state_sync` (contacts). The one-time request should be **after** Embedded Signup, verified WABA/phone ID discovery, sender registration, callback verification, history consent, and receiver readiness. Both must be initiated within the documented onboarding window (currently 24 hours). This ordered approach avoids unnecessarily collecting other tenants' messages while identity is unknown.

**Do not assume unrequested early Meta events are impossible.** Confirm actual subscription, callback precedence, and signed provider delivery before QR. Unknown signed history is still rejected, not silently acknowledged. Do not rely on retries as a recovery mechanism.

## Existing paid service only

- Keep primary `/webhook`, Messenger `/meta-webhook`, and existing phone/WABA overrides unchanged.
- The production history receiver added in PR #425 remains off until all post-onboarding identity, callback and consent proofs are obtained.
- After authorization, enable only the receiver's existing default-off gates and sender-scoped passive importer. No secondary AI, staff sending, templates, media sending, outbound transport, billing or follow-ups.
- A successful history `POST` must **never** be inferred from an onboarding completion event or the appearance of a QR. The production manual dispatcher requires BOTH the existing production receiver configuration AND:
  - `WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_ENABLED=true`
  - `WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_OPERATOR_APPROVED=true`
  - `WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_APPROVAL=APPROVED_ONCE_ONLY_META_SYNC` (CLI execution confirmation only)
- Exact Meta WABA and phone ID must match the independently verified `neutro_secondary` sender in `whatsapp_sender_accounts`, with `state=active` and `coexistence_enabled=true`.
- Run only via the **existing manual** `scripts/pr395ManualCoexistenceSync.js` entrypoint. Dry-run first. Each real request requires `--execute`, `--confirm=IRREVERSIBLE_ONCE_ONLY` and the script's separate proof flags (operator, receiver, importer, subscriptions, callback, data-sharing consent, timestamps). Never invoke from startup, webhooks, cron, or Embedded Signup callback.
- `PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED` must remain OFF for the paid production receiver. QA staging retains its original restricted path and approval.
- DB ledger `whatsapp_coexistence_sync_dispatch_requests` reserves each sender and sync type ONCE. An ambiguous/timeout outcome is treated as unknown; do not retry blindly.

## Controlled sequence after future approval

1. Verify current Linkie Meta app subscriptions and app-default signed webhook deliveries, including primary override precedence.
2. Verify current primary Neutro WhatsApp and Messenger live operation; review deployment/rollback readiness.
3. Run a separate synthetic receiver/storage rehearsal with a disposable local PostgreSQL database.
4. Only after QR approval: complete Embedded Signup for exactly +60 17-483 1336; verify Meta Graph WABA/phone identity, ownership, Coexistence status, token vault and consent.
5. Register exact sender and enable the passive history receiver under a controlled paid-service deployment, keeping all sends OFF; check signed live routing.
6. Run dry-run manual sync, then seek separate explicit approval for each irreversible Meta history/contact request while inside the 24-hour window. Preserve request IDs.
7. Verify durable job staging, contacts/messages under secondary sender, duplicate replay handling, and absence of AI/outbound activity. Keep primary and Messenger tests passing.
8. Activate manual outgoing messages and later AI only in separately approved stages.

The manual dispatcher gate does **not** itself prove real delivery. Code CI and synthetic signed HTTP tests are prerequisites, not authorization to scan the real QR.
