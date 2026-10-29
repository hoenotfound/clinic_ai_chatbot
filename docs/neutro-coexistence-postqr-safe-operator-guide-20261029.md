# Neutro Sense: second WhatsApp Business App cutover after PR #429

**Target:** 中医养生馆, +60 17-483 1336. The existing primary is +60 11-3053 5053.
**This file is an operator checklist; it performs NO activation, registration, callback change or history request.**

## Before QR

1. Finish PR #429 CI and reviewed deployment. Independently repeat primary WhatsApp/Messenger reply smoke tests.
2. In the paid Render Shell verify the separate vault and bounded receiver: `credentialVaultReady(process.env)===true` and `assertCaptureConfig(process.env)` passes. The early capture expiry must still be **in the future**. Renew a short window before QR only after reviewing consent; no automatic extension. The original 29 Oct 2026 window expires at **19:17 MYT**.
3. Confirm Meta's Linkie-owned app config supports *WhatsApp Business App onboarding*, select only +60 17-483 1336. App-default callback: `https://neutrosense.dasmarketingsolution.com/whatsapp/default`; primary WABA/phone-specific overrides remain `https://neutrosense.dasmarketingsolution.com/webhook`. Do not switch the primary account callback or use a separate paid Render.
4. Ensure **all** second-number sends, AI, templates, media, follow-ups, billing, automated sync and import are still OFF.
5. Remember the synthetic signed event (WABA `9999999999999999999999999001`) is a TEST hold. Never treat it as authenticated Neutro history, release it to Inbox, or infer real Meta delivery from it.

## Immediately after QR, before any sync

1. Obtain the single completed `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` result and backend **validated attempt ID**. Stop for a standard `FINISH`, auth code or Graph error.
2. Validate separately through Meta: WABA owns the actual phone ID; display normalizes exactly to `60174831336`; `is_on_biz_app=true`, `platform_type=CLOUD_API`; token belongs to the Linkie Meta app and includes the required management/messaging scopes. The account and phone IDs must differ from Neutro's primary. Do not guess ID values based on earlier messaging accounts.
3. If Meta status has not propagated, **do not scan a second QR or re-consume the signup code just to update the status**. Retain the encrypted credential and record. Recheck later via the new operator-only command, **after** pinning verified secondary account/phone IDs in Render. Default is read-only:
   ```bash
   node scripts/neutroSecondaryCoexistenceStatusRecheck.js --attempt=<VALIDATED_ATTEMPT_ID>
   ```
   If it shows ready, operator may separately approve `WHATSAPP_SECONDARY_STATUS_RECHECK_OPERATOR_APPROVED=true` and execute exactly:
   ```bash
   node scripts/neutroSecondaryCoexistenceStatusRecheck.js --attempt=<VALIDATED_ATTEMPT_ID> --execute --confirm=VERIFIED_META_STATUS_ONLY
   ```
   This updates only the signed-up record's `coexistence_ready` flag; it does **not** register sender, send, import or change webhooks. If it remains not-ready, STOP and investigate Meta status.
4. In a separate reviewed release, register the exact `neutro_secondary` sender as *active Coexistence* in `whatsapp_sender_accounts`. Set only secondary-specific WABA/phone pins and the approved inbound/passive-history flags. Never overwrite primary `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` or callback override. Verify existing main number and Messenger again.
5. Activate the strict production history receiver after checking signed live Meta delivery and provider routing for the exact secondary WABA/phone, with the early receiver switched OFF. Keep secondary sends and AI OFF. Test incoming messages/staff echoes separately; early capture handles `history` / `smb_app_state_sync` only. No assumption that Inbox will mirror secondary live chats immediately after QR.
6. Dry-run `node scripts/neutroEarlyHistoryHandoff.js`, verify true identity and sender-specific held event counts, then separately approve and execute bounded handoff (5 events per invocation). Only a verified history importer may persist historical contacts and text. It must not create new AI turns, customer service windows or marketing consent.
7. Contact and history `smb_app_data` requests are **separate once-only provider actions**, not made by signup or recheck; authorize only after a successful dry-run of `scripts/pr395ManualCoexistenceSync.js`, verified signed subscriptions/callbacks, persisted consent and importer readiness, within Meta's onboarding sync window. An unknown network outcome is not safe to blindly retry.

## Large history and expiry boundaries

- PR #429 raises the paid `/whatsapp/default` parser limit to **16 MB**, leaving primary `/webhook` unchanged. Signed oversized history/contact arrays are split into encrypted child holds no larger than **8 MB** each, with a strict **128-child limit per staging call**, transaction rollback on failure, and replay deduplication.
- Events greater than the outer 16 MB limit, single unsplittable items larger than 8 MB, malformed metadata and exhausted budgets still **fail closed**. These are not guaranteed import successes or guaranteed Meta retries. Monitor actual incoming event sizes and failures; investigate before irreversible once-only sync.
- The pre-QR capture flag expires according to `WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL`, regardless of server uptime. Encrypted unverified holds have separate **48-hour** logical expiry; physically purge only with explicit approval. The importer has its own later retention. Do not extend these windows silently or rotate the production vault encryption key after creating holds.
- Historical media uses placeholders rather than original files. Disclose this before promising a full multimedia archive.

## Minimum read-only checks

```sql
SELECT sender_key,meta_account_id,meta_phone_number_id,state,coexistence_enabled
FROM whatsapp_sender_accounts ORDER BY sender_key;
SELECT candidate_waba_id,candidate_phone_number_id,event_field,COUNT(*) AS events
FROM whatsapp_secondary_early_history_hold
GROUP BY 1,2,3;
SELECT status,COUNT(*) FROM whatsapp_sender_coexistence_import_jobs GROUP BY status;
```

**No automatic Meta registration, callback rewrites, customer messages, secondary AI, history sync or production deployment are performed by PR #429.**
