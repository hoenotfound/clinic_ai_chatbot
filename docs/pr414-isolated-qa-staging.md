# PR #414 isolated QA staging: safe activation checklist

**Status: deployed to QA staging and real-DB synthetic rehearsal PASSED. Do not scan a Coexistence QR, send to Meta, merge into production, or change Neutro production without separate release approval.**

## Existing resources verified 28 October 2026

- Render free staging service: `srv-dbdgmnks728c73btahcg`
  (`da-chatbot-pr395-staging`), auto-deploy disabled.
- Current staging branch: `pr395-history-handoff-20261028` at reviewed commit `3c4771d0`. PR #395 remains separate.
- Neon *QA* project: `wandering-dream-82267835`, branch
  `br-late-sky-ao8xggam`. **This is NOT Neutro production Neon.**
- Encrypted source database: `neondb` under existing
  `pr395_staging_owner`. Schema is old QA **104**, with **zero**
  capture events and secondary sender accounts at preparation.
- The source capture table now has `handoff_completed_at` and the
  `idx_secondary_qa_handoff_pending` partial index. These were applied
  ONLY to existing QA `neondb`, without clearing any data.
- Destination database: `pr414_forward_qa`, with its own
  `pr414_forward_qa_owner` login; verified initially empty.
- Both databases use the **same Neon project and compute**, so creating
  another Render service or Neon compute is not needed.

## A. Code and migration safety gates

1. Require green checks on draft [PR #414](https://github.com/hoenotfound/clinic_ai_chatbot/pull/414).
   The forward-only SQL lineage must be 001–079 (including sales
   follow-up 078/079), then new multi-number migrations 080–106.
2. **Do not deploy the new branch against `neondb`.** Its existing
   078–104 migration history conflicts with this branch. Do not rename,
   truncate or replace `schema_migrations`, and do not copy any real
   Neutro contacts into this QA environment.
3. The Render Git branch cannot be changed through the current connected
   Render actions. The operator must change the **free staging service's**
   branch to `pr395-history-handoff-20261028` through Render dashboard.
   Do not deploy until its `DATABASE_URL` is also changed to the new
   `pr414_forward_qa` connection string. Coordinate both settings
   while staging is stopped or otherwise prevented from restarting with
   the old DB and new code combination.
4. Obtain `DATABASE_URL` for `pr414_forward_qa` using Neon project QA,
   role `pr414_forward_qa_owner`. Preserve the existing QA `neondb`
   connection as `WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL` with its own
   old QA role. **Never paste secrets or URLs in PR comments or logs.**
5. On **staging only**, the explicitly pinned same-host exception needs:
   - `PR395_STAGING_MODE=true`
   - `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ALLOW_SAME_QA_HOST=true`
   - `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE=neondb`
   - `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE=pr414_forward_qa`
   - `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST`: the exact
     destination Neon hostname, not the database name
   - `WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST`: the exact source Neon
     hostname (same compute in this QA-only arrangement)
   - `WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL`: existing old QA source
   - `DATABASE_URL`: the new empty QA destination
   Production retains the original different-host QA isolation and
   does NOT use this staging-only exception.
6. **Keep ALL real secondary capture/handoff/sync/send gates OFF** until
   the separately approved live procedure. In particular:
   `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED=false`,
   `WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED=false`,
   `WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED=false`,
   `PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED=false`,
   all secondary outbound, AI, staff, template and follow-up flags false.
   Do not copy any real production WABA tokens into staging for the synthetic
   checks. No Meta QR, `smb_app_data` POST or real customer sending.
7. With the new code and new database selected, manually deploy the
   existing free staging service once. Its normal `initSchema` process
   applies 001–106 **only to `pr414_forward_qa`**.
8. Confirm read-only:
   ```sql
   -- Run against pr414_forward_qa only
   SELECT max(version), count(*) FROM schema_migrations;
   -- Expect version 106, 106 migrations.
   SELECT (SELECT count(*) FROM contacts) AS contacts,
          (SELECT count(*) FROM messages) AS messages;
   -- Expect no real customer rows.
   ```
   Separately on source `neondb` verify version 104, the checkpoint
   column and index, and unchanged source capture counts.

## B. Synthetic history rehearsal before real Meta identity

Use synthetic WABA/phone values that are NOT production IDs. Register a
synthetic second sender in destination in `active` state, retain the
synthetic capture source sender in `testing` state, and use an isolated
signed and consented test event. The importer and handoff are
operator-invoked, never automatically scheduled.

Confirm a history customer and business reply appear in the second sender's
Inbox with original timestamps, 620-message splitting, replay deduplication,
media placeholders, and no outbound or billing side effects. Check old QA
`neondb` and Neutro/Facebook Messenger remain unchanged.

## C. Stop conditions

- Wrong database hostname, name, owner role or branch commit.
- Existing QA `neondb` unexpectedly migrated past schema 104.
- A sender is mapped to the primary Neutro phone ID.
- Any AI/outbound/template/follow-up worker on the second sender becomes active.
- Missing signed Meta evidence, new customer charge, or any unauthorized
  Meta sync request.
- Unknown one-time sync status, missing history consent, missing verified
  WABA/phone ownership or any change to Neutro's primary override.

**A green synthetic test does not authorize QR onboarding.** Real Meta
signed delivery and consented history import still require supervised checks.

## D. Completed synthetic live-QA evidence — 28 Oct 2026

Render staging deployed commit `3c4771d0` with explicit one-shot
`PR414_QA_SYNTHETIC_REHEARSAL_ON_BOOT=true` and separate synthetic operator
approval for one run only. The actual Node capture service, AES-GCM
encryption, QA Postgres handoff, sender-qualified import and replay checks
all passed without sending messages or calling Meta.

- 2 captured history/contact changes; 2 durable transfers
- 3 Inbox history messages with correct sender identity, names, original
  timestamps, one media placeholder and inbound/outbound role direction
- Identical signed-receiver-equivalent synthetic retry: zero duplicates
- Billing attempts: zero
- Source QA remained migration 104; target remained migration 106
- All rehearsal source and target test rows were cleaned; read-only
  Postgres queries independently confirmed 0 source/target senders,
  captures, contacts, messages, import jobs and sync events
- Rehearsal/approval flags were set back to `false` and staging remained live
- Full GitHub CI succeeded for this head

The synthetic function supplies a test-only `signatureVerified` proof
after bypassing HTTP (actual signed HTTP is separately covered by CI).
This is **not** genuine Meta-origin webhook delivery.

See `docs/pr414-pre-qr-release-gates.md` for the remaining production
and actual Meta approvals.
