# PR #395: manual GitHub Actions rehearsal of isolated signed lifecycle webhook

**Status: NOT RUN.** This document accompanies an independent **workflow-only draft PR**, separate from the application PR #395. This is a synthetic staging-only test, NOT permission to change a Meta callback, onboard a phone, run a one-time sync, alter Neutro production, or merge PR #395.

## GitHub workflow registration constraint

GitHub requires a `workflow_dispatch` workflow to exist on the repository's default branch before it can be run manually. This PR intentionally does NOT change `main`: the owner must **review and explicitly approve a separate merge of this workflow-only PR** before any manual dispatch. The application PR #395 stays Draft and unmerged. Do not use `pull_request_target`, automatic triggers, or PR-built artifacts to bypass this restriction.

## Secure one-time setup after the workflow-only PR is approved

1. In GitHub repository **Settings > Environments**, create `pr395-isolated-webhook-rehearsal`. Add required reviewers where available and restrict deployment branches to **main only**. Require owner approval before accessing environment secrets.
2. Under **this environment's Secrets**, create `PR395_STAGING_HMAC_SECRET` with the same DA CHATBOT Meta **App Secret** that the isolated staging service uses as `WHATSAPP_APP_SECRET` / `META_APP_SECRET`. Never put this value in a workflow input, repository-level secret, PR comment, chat, terminal echo, or source file. GitHub's masking helps but is not a substitute for limiting secret access.
3. Verify isolated Render service `srv-dbdgmnks728c73btahcg` (https://da-chatbot-pr395-staging.onrender.com) is **Live** on an approved PR #395 commit, connected only to isolated Neon project `wandering-dream-82267835` (schema v104 or newer). Require `PR395_STAGING_MODE=true`, `PR395_STAGING_LEGACY_LIFECYCLE_ENABLED=true`, pinned verified Neutro WABA/phone, identical Meta app secrets, personal QA identity pin, no secondary sender Meta IDs, and all outbound/provider processing OFF.
4. Require `PR395_STAGING_LEGACY_LIFECYCLE_ALERT_ENABLED=false` or unset. Otherwise a synthetic noncritical review alert may be sent to Telegram. Do not turn it on before test records are reviewed and explicitly cleaned up.
5. Confirm Meta app-default remains `https://clinic-ai-chatbot.onrender.com/webhook`; Neutro account-specific override remains `https://neutrosense.dasmarketingsolution.com/webhook`. No Meta callbacks need changing.

## Explicit manual launch (after separate approval and registration)

GitHub **Actions > PR395 isolated signed webhook rehearsal > Run workflow**; select **main**, type `STAGING_ONLY`, and review the environment approval request. The workflow is never triggered by `push` or `pull_request` and skips when invoked from any non-main ref. It uses no `checkout`, no PR code, no packages, no GitHub token permissions, and no user-supplied endpoint. Its only external destination is the fixed isolated staging HTTPS route `/pr395-legacy-lifecycle-webhook`.

A single execution checks (in this order):

- Invalid raw-body HMAC rejected without durable acknowledgment.
- Foreign WABA rejected without durable acknowledgment.
- Foreign business phone rejected without durable acknowledgment.
- Valid signed **`PR395_SYNTHETIC_REHEARSAL`** event accepted with HTTP 200 and `X-DA-Legacy-Lifecycle-Accepted: 1` after the receiver's Neon COMMIT.
- Exact replay accepted without a duplicate insert. The job displays the SHA-256 fingerprint, never the secret.

The event includes a unique rehearsal marker in its signed payload. It is deliberately **not** a `PARTNER_REMOVED`, `ACCOUNT_OFFBOARDED`, or other actual disconnect signal, and can never disable the real Neutro sender. The workflow cannot verify database row counts on its own, so those are confirmed separately through the *isolated Neon connector* with read-only SQL. A successful HTTP response is not by itself proof of exactly-once persistence.

After the run, query isolated staging Neon ONLY:

```sql
SELECT fingerprint,account_id,event_type,recorded_at
FROM whatsapp_legacy_lifecycle_relay_audit
WHERE fingerprint = '<exact fingerprint printed by GitHub Action>';

SELECT fingerprint,account_id,event_type,severity,delivery_state,attempts
FROM whatsapp_pr395_legacy_lifecycle_alerts
WHERE fingerprint = '<same fingerprint>';
```

Expected: one audit row and one `severity='review'`, `delivery_state='pending'` alert. Do not enable the Telegram alert worker while the synthetic record remains pending. Remove or mark the test data only after separate approval and an exact-fingerprint, isolated-database cleanup plan.

## Fail-closed and scope limitations

- If the environment secret is missing or malformed, no request is sent.
- If HMAC fails, an identity mismatch is wrongly accepted, valid delivery returns non-200, or a durable ACK is absent, the job fails with no retry of the accepted event.
- Automatic retries, checkout, deployment, API token provisioning, `smb_app_data`, inbound AI, Meta subscription, phone registration and Meta callback modification are **not implemented here**.
- This test directly exercises the **deployed PR395 staging receiver**, not the inert standalone relay nor real provider traffic. Passing does **not** authorize relay cutover or QR scan.
- A synthetic event stored in staging is not proof a real Neutro disconnect would traverse Meta's app-default callback. A later separately approved provider-route acceptance and full WABA inventory remain required.
