# WhatsApp multi-number rollout — Neutro Sense (development only)

Status: **foundation implemented; NOT ready to enable**. No Meta subscription,
phone registration, Render secret, or production database changes are performed
by the foundation code.

## Business goal

Keep Neutro Sense TCM and Ariel Lee in one **Neutro Sense Render + Neon + Inbox**
while allowing each WhatsApp number to retain its own Meta account, credentials,
reply windows and coexistence policy. Use the same *shared* Meta Developer App.
The client business does not need to own/administer that Developer App.

Meta phone and account IDs must be verified from authenticated Graph API reads
before activation; never assume that display names identify the active sender.

## Foundation in this change

- Migration 078 adds `whatsapp_sender_accounts`, with **no tokens**, state
  default `disabled` and a per-sender coexistence flag.
- Migration 078 does NOT ALTER existing contacts/messages or create indexes on
  those live tables. Sender provenance columns must be added later, after
  full per-number routing and a separate database rollout plan are ready.
  No historical contact IDs or message rows are rewritten.
- `whatsappSenderRouting` can validate a webhook's real
  `entry.id` (WhatsApp account) and
  `value.metadata.phone_number_id` (receiving business phone).
- It rejects unknown, disabled, and mismatched senders instead of guessing.
- Testing-state senders can be inspected but NEVER authorize live routing; there
  is no caller-controlled `allowTesting` bypass. Explicit activation is a
  separate, reviewed workflow, not a webhook option.
- Registry lookup Maps are private; callers see immutable sender snapshots.
- Customer identities use the same side-effect-free Malaysian phone
  normalizer as the existing contact database, with strict key validation.
- All existing WhatsApp inbound, status, reaction and Business App echo parsers
  now carry optional `businessPhoneNumberId` AND `businessAccountId` from
  provider metadata and the corresponding entry (only when receiving-phone
  metadata is available).
- The new **standalone** batch inspector validates the top-level webhook type,
  recognizes message/status/Business App echo events, classifies passive
  `history` and `smb_app_state_sync`, and rejects new/unrecognized event fields.
  A future ingress integration must quarantine unsupported event batches with
  operational alerts rather than redelivering them endlessly.
- Passive sync is not a customer conversation and must never trigger AI replies.
- Existing single-sender transport and all live webhooks are unchanged.
- The new registry validator is **not connected to live multi-number routing**.
  Future routing must validate an entire batch before persisting any part.
- The existing single-number webhook now rejects **explicitly foreign phone IDs**
  from inbound/status/staff-echo processing and durably records an opaque hash
  in `whatsapp_sender_quarantined_events`. It preserves callbacks for the
  configured existing number. Legacy callbacks missing receiving-phone
  metadata are preserved by default; strict metadata mode remains opt-in
  until verified safe using live provider samples.
- Unknown webhook fields are quarantined independently of valid callbacks;
  the sender registry is not an invitation to subscribe Ariel to this URL.

## Required before enabling a second phone

1. Verify the *currently configured* Neutro Sense Meta phone ID against
   Render's `WHATSAPP_PHONE_NUMBER_ID`, and separately verify Ariel's
   account and coexistence status. Do not infer from other dashboard listings.
2. Backfill all historical WhatsApp contacts and messages to a verified
   default sender without rewriting existing IDs; guard the backfill against
   misassigned records.
3. Change contact identity from a globally unique `whatsapp_number` to
   `(whatsapp_sender_id, normalized_customer_number)`; adjust the
   `idx_contacts_channel_user_id` uniqueness rule for WhatsApp without
   weakening Facebook/Instagram uniqueness. Update manual contact creation,
   imports, merges, exports, lead joins and privacy deletion.
4. Persist sender ID with every inbound claim, message, scheduled send,
   follow-up attempt, billing reservation, retry and provider-status result.
   Recovery workers must use persisted sender identity, never the current
   default or phone number alone.
5. Implement a credential resolver keyed by **persisted sender ID** for
   text, buttons, image/video/audio upload/download, templates, media ID cache,
   catalog lookup, quick reply, pricing graphics and manual/retry sends.
   Fail closed on missing/revoked credentials. Keep secrets in Render or a
   proper secrets manager; never include tokens in webhooks, logs or JSON APIs.
6. Scope 24-hour messaging windows, CTWA free-entry and billing claims, opt-in,
   opt-out, follow-up slots, template catalog and content rules to a specific
   sender+contact thread. Choose deliberate policy for global opt-out handling.
7. Key Business App staff echo handoff and AI-cancellation locks on
   `(sender ID, customer)`, so staff on Ariel cannot cancel Neutro AI.
8. Verify each webhook signature, account ID, business phone ID and sender
   state before accepting a batch. Unknown phone metadata must never route
   to the default sender. Ensure each Meta account has the intended
   `override_callback_uri` and fields; no modifications in this PR.
9. Present sender names on every Inbox conversation and above the composer,
   with All/Neutro/Ariel filters. Sender selection is derived from the
   conversation, not a free-form send dropdown.
10. Release with a **separate activation approval**, real two-number Meta
    verification, database snapshot, and rollback. Never auto-register a
    coexistence phone through the normal Cloud API registration endpoint.

## Rollout / rollback order (future work; not executed)

1. Deploy read-only and schema compatibility changes while legacy routing
   remains the only active sender.
2. Backfill and verify existing records and uniqueness constraints on a
   temporary database branch, then stage compatible application changes.
3. Verify existing Neutro ordinary AI/manual messages, status receipts,
   follow-ups, pricing rules, staff takeover and user-visible Inbox behavior.
4. Authorize Ariel through the Business App QR path **only after approval**.
   Require `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`,
   `is_on_biz_app=true` and `platform_type=CLOUD_API`.
5. Configure Ariel-specific credentials and webhook subscription independently;
   verify existing Neutro webhook override remains unchanged.
6. Keep Ariel `testing` and automated replies paused; test each path and
   negative cases before making the sender `active`.
7. Roll back by disabling Ariel inbound/automations and restoring **only**
   Ariel's prior callback after the owner confirms. Preserve legacy sender,
   data, and audit records; do not replace production Meta credentials.

## Mandatory regression tests

- Same customer on both numbers produces separate contact/conversation IDs.
- Inbound, outbound, delivery status, media uploads, templates, scheduled sends,
  automatic follow-ups and retries preserve their original sender ID.
- Staff echoes from Business App only affect the corresponding sender thread.
- Unknown/missing metadata, a mismatched WhatsApp account, and disabled sender
  fail closed without inserting a contact or sending an automated response.
- Duplicate/late/failed receipts and replay after restart remain idempotent.
- CTWA/billing windows and opt-in/opt-out decisions cannot use another sender.
- Backward compatibility of the existing Neutro single-number deployment.
- Human review of both WhatsApp account subscriptions and callback overrides.

**Do not enable multi-number routing just because migration 078 exists.**

## Hardened legacy webhook boundary — production rollout gate

- The boundary runs **after Meta signature verification** and **before** any
  contact creation, AI, WhatsApp Business App staff echo, delivery status,
  or reaction processing. `WHATSAPP_PHONE_NUMBER_ID` is required to identify
  the existing sender; a missing ID returns a retryable error instead of
  mixing an unknown account into the Neutro Sense Inbox.
- Ordinary customer messages, status receipts and reactions are accepted only
  from `messages` field changes; Business App echoes only from
  `smb_message_echoes`. Malformed event arrays and passive sync events
  containing disguised top-level messages are quarantined. This is **not**
  historical-message import or replay.
- `WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED=true` additionally checks
  `entry.id` against `WHATSAPP_WABA_ID`. Keep this flag disabled **until**
  live callback evidence verifies that the configured WhatsApp account ID
  really owns the production number. Never guess ownership using a dashboard
  name. Likewise, opt into `WHATSAPP_SINGLE_SENDER_STRICT_METADATA=true`
  only after observing genuine incoming callback metadata.
- Quarantine writes are one bounded database statement. For **foreign-only**
  batches, a failed audit returns 503 so Meta can retry. For **mixed**
  batches, the valid Neutro work is saved and acknowledged independently;
  quarantine is a post-ACK best-effort audit with an operational warning.
  An audit failure must not delay a valid Neutro patient message.
- Quarantine only stores opaque SHA-256 digests and Meta business-side IDs,
  not customer phone numbers or message content. If Telegram alerts are
  configured, a throttled operational alert is sent; without Telegram, the
  application error/warning log and quarantine ledger must be monitored.
  A misrouted message is **not recoverable from the privacy-safe audit**.
  Operators must correct the Meta override and ask affected customers to
  resend if necessary. Do not claim this is a second-number Inbox.
- Never subscribe Ariel Lee to the production Neutro Sense webhook or enable
  sender-aware routing until per-number contacts, credentials, follow-ups,
  receipts, staff takeover, and privacy rules are implemented and tested.


## Read-only production sender mapping audit (before activation)

On a trusted operator machine holding the **existing client runtime environment**
and a management-scoped Graph token, run:

```bash
npm run whatsapp-sender:verify -- \
  --runtime-env-file ./client-runtime.env \
  --client-url https://da-chatbot-neutro-sense-tcm.onrender.com
```

The command reads the configured WhatsApp account, phone, shared developer app
and callback through the Meta Graph API and verifies:
1. The production phone ID appears on its configured WhatsApp account.
2. That account has a subscription for the shared DA CHATBOT developer app.
3. The app-specific callback override matches the client's `/webhook`.

No subscription, token, phone registration, or runtime environment is changed.
A false or unavailable result **blocks strict account-ID activation** and
requires operator-level inspection of the shared app; never attach ownership
of the shared developer app to the client to make the client-scoped connector
status light green. The business-level connector is insufficient to inspect
the shared operator app, and the production Render connector cannot reveal
the existing environment values for this check.

## Staging evidence — 22 Oct 2026

- A separate Neon branch `qa-pr384-whatsapp-isolation-20261022` was created
  from the production branch, without modifying live data.
- Migration 078 applied successfully to a real branch snapshot of **183
  contacts and 2,196 messages**. Historical row counts and fingerprint hashes
  remained unchanged, and the sender registry stayed empty.
- Synthetic rejected-event records were inserted twice with upsert, retaining
  exactly one audit record with `seen_count=2`. Existing data remained intact.
- A test using the actual Express webhook route with in-memory dependencies
  simulates quarantine database failures. Genuine Neutro inbound events in a
  mixed callback are durably accepted with HTTP 200 even if their unrelated
  foreign-event audit fails; foreign-only and passive+foreign callbacks return
  retryable HTTP 503 if no durable quarantine can be written.
- **Production remains on migration 077**, and no shared Meta app subscriptions,
  coexistence QR authorization, existing Render settings, or phone mappings
  were modified.
