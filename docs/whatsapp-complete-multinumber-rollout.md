# DA CHATBOT multi-number WhatsApp — Phase 2 consolidated PR #395

**Status: Draft implementation, isolated Neon QA migrated through v099; live coexistence unverified. NOT APPROVED FOR PRODUCTION.**

**26 October 2026 read-only Meta inventory:** The selected second Business App number **中医养生馆** (+60 17-483 1336) is linked to phone number ID `1318355951360575` in phone-owning WhatsApp Account `1071636698738276`. Its linked Messaging Account for partner-specific templates/billing is `1852014482431209`. These distinct account types were read from the Neutro Sense Face & Body business inventory; a previous Graph `/{1071636698738276}/phone_numbers` failed because it does not establish that the WhatsApp Account node supports the legacy messaging-account phone edge. The app-specific authorization, `waba_id` returned by Embedded Signup, callback `entry.id` identity and DA CHATBOT subscription remain **unverified**. Do NOT copy the WhatsApp Account ID into `WHATSAPP_SECONDARY_WABA_ID` until the exact webhook/messaging identity is confirmed with the DA CHATBOT token. The Meta DA CHATBOT App ID is `1029862536608134`, and second-number AI content/billing still need explicit owner approval.

All Phase 2 implementation is kept in a single Draft PR #395. Older work
from #384, #387, #389, #391, and #393 is included. No Phase 2 feature
has been merged to `main`, deployed, or enabled in Render.

## Built and sender-isolated

- Existing Neutro WhatsApp number remains the primary, with its current
  Meta token, legacy delivery/billing tables and unchanged content.
- the secondary sender has a distinct phone-ID-qualified contact identity, Inbox sender
  label/filter, bounded inbound conversation, and sender-specific Graph
  transport. One customer's Neutro and the secondary sender chats never share a contact.
- Signed webhook partition stages the secondary sender's delivery/pricing receipts to
  separate tables and rejects mixed/mismatched phone/account evidence.
  Neutro statuses continue through the existing handlers.
- the secondary sender staff and AI text replies use the verified sender, fresh 24-hour
  window, one-shot saved-message reservation, audited receipt settlement
  and no legacy fallback or automatic retry.
- the secondary sender staff media uses separate uploads for image, video, audio, document
  and sticker; no Neutro media IDs/cache are reused.
- the secondary sender templates have their own WABA-approved live catalog, explicit
  opt-in/marketing-consent checks, one-time staff billing-review claim,
  text/image/video components and per-message audited authorized paid
  receipts. Unapproved charges and failed callbacks latch an alarm.
- Each the secondary sender contact has a separate unresolved billing gate. The global
  sender alarm still halts every the secondary sender contact after an adverse receipt.
  Nonbillable `free_entry_point` receipts can release the gate when
  explicitly enabled; confirmed staff-approved billable template receipts
  have a separate explicit approval gate. Unknown deliveries cannot be
  retried or cleared automatically.
- the secondary sender 2h/6h/20h follow-ups use independent **clinic-authored**, sender-
  owned rules with one-shot claims, sender-specific media, opted-in and
  marketing-consent checks, appointment/staff takeover avoidance, 00:00–07:00
  quiet hours, fresh service-window and config revision rechecks.
  **No rules or schedule are seeded by the migration.** A crashed/unknown
  send is never retried automatically. The legacy Neutro worker remains
  separate.
- Generic Inbox retry for the secondary sender is denied before the primary retry policy.

## Default-off controls

All WhatsApp multi-number flags and the secondary sender sender-specific switches remain
false in `.env.example`. In particular:

```
WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED=false
WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED=false
WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED=false
WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=false
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=false
WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_AI_SEND_ENABLED=false
WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED=false
WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false
```

Enabling one switch is not sufficient. The startup activation gate checks
its dependencies and sender identity. **Do not enable these all at once
against production.**

## Migration rehearsal — 2026-10-22

Neutro Neon project `steep-forest-44509907`:

- Production branch `main`: schema v077, unchanged (read-only verification)
- Isolated QA branch `qa-pr395-final-multinumber-20261022`
  (`br-steep-flower-b3qayk0r`): migrations v078–099 applied
  successfully and atomically (latest check 2026-10-23)
- Existing contacts retained: **183**
- Existing primary billing-gate rows retained: **1**
- New sender accounts/follow-up rules/attempts: **0** automatically seeded
- Both sender-only follow-up SQL queries passed PostgreSQL `EXPLAIN`
  on the isolated production-shaped QA branch
- Real PostgreSQL regression tests in CI also validate schema and
  sender isolation. Check the current exact-head GitHub Actions result
  before calling CI green.

The QA branch is intentionally kept for controlled Meta tests and
rollback rehearsal. It has its own compute and may consume Neon quota.
Never point the live Render service at this branch.

## Go-live blockers and tests outside GitHub CI

1. Verify the new secondary number's registered phone/account IDs (already resolved), separately authorize Meta token,
   exact Meta application secret, business portfolio ownership and
   coexistence onboarding. Do not assume the numbers share WABA.
2. Test actual signed inbound/status callbacks for both numbers in a
   **separate staging deployment**; check Meta permission/subscription
   scope and never use production token as an the secondary sender fallback.
3. Test a staff reply, AI reply, media, template (free and billable), opt-out,
   recipient mismatch, late billable callback, status ordering and concurrent
   contact sends with **real provider receipts** before activation.
4. Configure/approve the secondary sender's content and follow-up rules explicitly.
   2/6/20-hour service-window follow-ups are implemented; **48h/72h
   proactive marketing-template automation is NOT enabled by this branch**.
   A separate provider-compliant marketing opt-in, sender-specific template
   and spend authorization is required before those are turned on.
5. Confirm actual billing costs and a controlled alarm-resolution process
   with Meta Billing Hub. An unexplained charge must never be auto cleared.
6. Ensure the secondary worker can be disabled independently, verify
   archival/retention impacts and run two-number rollback drill.

## Safe rollout order

1. Review and merge only after backend/frontend/browser tests pass and
   migration checksums match the isolated branch.
2. Deploy with every new sender **send flag OFF** and verify the primary
   Neutro message, media and follow-up flows still function.
3. Enable sender-aware Inbox and signed ingress only after confirming
   exact Meta identities. Check the secondary sender's inbound while keeping sending OFF.
4. Test staff text, then media, then AI text, then approved templates and
   receipts. Enable only one class of outbound behavior at a time.
5. Do not enable the secondary sender follow-ups until its own consent and content rules
   have been reviewed. No silent reuse of Neutro scripts or media.
6. Rollback: turn OFF only the new the secondary sender send/worker flags, maintain
   sender-aware reads once the secondary sender contacts exist, and preserve the receipt
   and attempt ledgers for reconciliation. Do not force clear ambiguous
   billing reservations.

**NEVER merge an unreviewed migration or switch the production Neon
DATABASE_URL to the QA branch.**


## Review remediation and release constraints (updated after six-area review)

PR #395 remains **Draft** and unmerged; Neutro's production branch remains
unmodified by this remediation. Code changes require **fresh exact-head CI**.

- Corrected the secondary sender reservation outcome updates to match one sender+contact+
  reservation and require atomic row counts. Tested reversed two-customer
  Meta acceptance order.
- Fixed the secondary sender media callback invocation, which previously risked sending
  the literal `[staff media]` text, and fixed the unit mock that missed it.
- Primary sender lookup now recovers stored Neutro identity during a read-flag
  rollback. Turning off scoped ingress after the secondary sender has customers is forbidden;
  leave permanent sender identity enabled and disable the secondary sender operations.
- Existing Neutro pre-registration delivery jobs can be verified by unique
  primary WAMID ownership and registration time; new untagged jobs fail closed.
- Preserved clinic-wide seven-day CTWA proof **only for Neutro's verified
  primary Meta identity**, while keeping the primary strict-billing gate.
- Meta `free_customer_service` signed nonbillable statuses can settle the
  exact the secondary sender reservation. Unknown Meta pricing is not treated as free.
- Definite provider HTTP client rejection and network/5xx ambiguity have
  different audit outcomes. Unmatched signed billable receipts hold the secondary sender;
  nonbillable bounced messages hold only the affected conversation.
- Sender-owned customer deletion now includes sender-specific contact records
  and privacy-minimized billing audit; foreign key cleanup must be regression
  tested against active and settled sends.
- Contact-access authorization and reply permission apply server-side to
  contact-scoped conversation routes; cross-business forwarding is blocked.
- Tools has an the secondary sender-specific text-only 2h/6h/20h rule editor, backed by its
  own staff-authorized endpoints. No Neutro media/rules are shared.
- Inbox displays separate sender capability and blocks the secondary sender's legacy retry
  control; Meta billing previews never inherit Neutro's evidence.

**Known external and operational release blockers:**

1. Real Meta coexistence, token identity and signed two-number webhooks
   have not been exercised on staging. Do not infer reliability from CI.
2. The old pre-PR Render application **cannot safely be redeployed** against
   migration 095: the migration runner rejects unknown future versions.
   Only perform a compatible forward fix / disable the secondary sender feature flags while
   maintaining permanent sender-scoped contact identity.
3. The application's migrations normally commit **per migration**, not as
   one all-or-nothing transaction in production. QA's explicit transaction
   does not change this runtime behavior.
4. Verify real provider pricing and explicitly approve any possible charges
   to the secondary sender's account. The 24-hour reply window alone **does not prove RM0**.
5. the secondary sender's AI-specific prompt/pricing/service settings require separate
   clinic approval; do not enable the secondary sender AI against Neutro's treatment content.
6. Autonomous 48h/72h marketing-template sending is **not implemented** for
   the secondary sender pending template, consent and billing approval.
7. Validate production Render's auto-deploy state before merge. Merging into
   `main` may immediately deploy while Neon has only migration 077.


## Safety follow-through — 2026-10-23 (code and isolated DB only)

- A CI regression that expected the previous safety-error string was corrected.
  The backend suite passed **3061/3061** on commit `d2bbcbb`.
- Migration `093_whatsapp_sender_early_receipt_recipient_proof.sql` was
  applied with a transaction-scoped advisory lock to the **isolated** QA branch.
  Ledger versions are 1–93, with a SHA-256 checksum of the exact migration.
  QA retained 183 Neutro contacts, 2203 messages and the existing primary
  billing gate. The production Neon branch remains at version 077.
- An explicit `WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=true` is
  required at startup **before any the secondary sender outbound capability** can be enabled.
  This is an acknowledgement of *potential* charges, not an atomic Meta
  spending limit or proof the current free monthly allowance is unconsumed.
  Keep it FALSE unless a responsible operator approves billing. Meta's
  [official FAQ](https://whatsappbusiness.com/resources/faq/) confirms that
  from 1 October 2026 each phone number gets 1,000 free service messages per
  month, then service messages are charged individually.
- **The prior operator approval applied only to the formerly proposed phone.**
  Content sharing for **中医养生馆** is **NOT YET APPROVED**. Do not
  reuse Neutro prompts, medical advice, price lists or promotions without
  this new number's owner explicitly confirming they are applicable.
  Until separately authorized keep
  `WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE` empty,
  `WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED=false`,
  `WHATSAPP_SECONDARY_AI_SEND_ENABLED=false`, and
  `WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false`.
  Startup/runtime checks enforce the explicit binding.
  This is **content sharing only**: Meta token, business phone ID,
  customer/conversation identities, consent, follow-up ledger and billing
  reservations must remain independent. Pricing/result media are not
  automatically sent by the secondary sender AI yet: the separate sender media/billing path
  must be verified first. **the secondary sender AI and follow-ups remain OFF in Render.**
- Live Render `da-chatbot-neutro-sense-tcm` follows `main` with
  **auto-deploy ON**. Do not merge this PR before staged signed Meta
  callbacks, exact credential/number verification, billing consent and a
  separate go-live authorization.
- 中医养生馆's WhatsApp Business App number is registered under the
  Neutro Sense business portfolio. That does **not** prove Meta coexistence,
  a sender-scoped token, or webhook subscription. The linked WhatsApp tools
  cannot inspect DA CHATBOT App `1029862536608134` under that portfolio.
  A client business need not own the developer's Tech Provider app: verify
  the actual authorized subscription and phone/account relationship, but
  do **not** move or connect client business assets solely to satisfy a
  limited connector's permissions.

### Forward-only rollback rehearsal

The real PostgreSQL sender-binding regression now tests all three cases:
(1) disabling the secondary sender send/AI/follow-up flags while retaining sender-aware
reads and ingress is accepted, (2) disabling sender-aware reads is rejected
when an the secondary sender contact exists, and (3) disabling scoped ingress is rejected.
The test also checks that the original Neutro message and both contact
records remain intact.

In a deployed failure, switch OFF all the secondary sender send and worker flags first,
preserve the sender-scoped registry/read/ingress flags and the billing audit
tables, and keep the running application at a version that **knows all
installed migration versions**. Do **not** redeploy the previous 077
binary against database schema 099, manually delete migration history,
reset unknown billing reservations, or point live Render at QA.

### Read-only Meta two-number preflight

Run only with a **staging callback URL**, and a runtime file containing
the verified first and second phone/account IDs and DA CHATBOT App ID.
Supply `WHATSAPP_MANAGEMENT_TOKEN` and
`WHATSAPP_SECONDARY_MANAGEMENT_TOKEN` in the operator environment, or
the corresponding sender-specific tokens in the runtime env file.
Do not put tokens on the command line or in an issue.

```bash
npm run whatsapp-sender:verify-dual -- --runtime-env-file ./staging.env --client-url https://your-staging-host
```

The command performs **GET requests only**, requires exact phone ownership
and app-specific callback subscriptions for **both** senders, and reports
`verified: false` if one side cannot be established. The primary token
is never reused for the the secondary sender account. A shared Meta account is supported
only when both phone IDs are separately proven within it. This preflight
is **not** a substitute for signed incoming/receipt tests and was not
run against live Meta until the correct staging tokens become available.

### What still needs real-world testing

A non-production Render deployment and authorized Meta app must be connected
to an isolated database, a valid shared or separate Meta callback setup and
approved test recipients. Then obtain *actual* signed provider receipts for
the secondary sender/Neutro inbound, staff text, media, template variables, pricing, wrong
recipient rejection and simultaneous messages. Check billing in Meta's
account UI. These are **not** established by synthetic CI webhook tests and
must not be marked complete without observable provider receipts. The user has approved
Neutro's existing business information, services, pricing, promotions and
clinical escalation content for 中医养生馆's number. Do not invent a second
clinic profile. Sender-specific outbound Meta credentials, billing/receipt
proof, opt-out history and customer context remain separate, and a real Meta
staging run is still mandatory before the secondary sender AI activation.

**Release decision remains Draft / no live changes.**

## Shared Neutro clinic content decision — 2026-10-23

The former secondary phone's clinic-content approval is historical and does
not carry over to **中医养生馆**. Neutro's existing content may become the
shared source ONLY if the owner explicitly authorizes the new number after
checking clinic name, professional services, prices, promotions and clinical
safety. Until then, senders remain isolated and automation stays disabled.

`secondaryUsesPrimaryClinicContent()` now explicitly enforces the approved
`primary` source and separate sender keys in the server's secondary AI
dispatch path and the startup gate. Regression tests prove wrong/missing
approval, missing billing acknowledgment, and missing receipt ingress still
fail closed, while a correctly configured secondary sender can use shared
clinic text without sharing its token or billing state.

**Important:** Code supports explicitly approved content binding, but the new number's approval is still outstanding.
It does not complete real Meta authorization, independent media delivery,
or billing approval. Keep
`WHATSAPP_SECONDARY_AI_SEND_ENABLED=false` and
`WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false` until an isolated staging
deployment has observed correct signed callbacks for BOTH phone numbers.
The existing the secondary sender follow-up worker still uses its own sender-owned,
staff-authored 2h/6h/20h rules; it does **not** inherit Neutro's scheduling
or send the 48h/72h marketing templates automatically.

## PR #395 follow-up remediation — 2026-10-23

The full five-item review has code-level fixes on the Draft PR:

1. **Service-message billing:** migration **094** adds a distinct
   `operator_acknowledged_service` reservation and
   `signed_meta_operator_authorized_service_charge` reconciliation method.
   It does not automatically consent to charges. Meta service charges are
   reconcilable only when a verified the secondary sender-specific operator acknowledgment,
   policy, exact sender, contact, WAMID and signed category=service receipt
   agree. Template charges still require a separate one-time staff review.
   An acknowledged but unautomated service charge holds only its own contact
   for manual reconciliation; an unexpected category still latches the
   global the secondary sender alarm. No primary Neutro billing tables are changed.
2. **Lead and follow-up safety:** the 2h/6h/20h worker now selects and
   rechecks the **chronologically newest** lead, including consent, appointment
   and pipeline stage. It allows limited (8-hour) catch-up after quiet hours
   or a worker outage while the verified 24h window remains open. Older
   due rules are skipped once a newer scheduled slot is due.
3. **Legacy Neutro Inbox identity:** unbound historical WhatsApp contacts
   receive a display-only virtual Neutro sender label after the primary
   registry and sender-aware ingress are verified. Contact IDs, sender
   billing ownership and historical messages are never backfilled.
4. **the secondary sender promotional and Before & After graphics:** migration **095**
   introduces a sender-specific durable picture queue. AI text still uses the
   shared approved Neutro service/pricing/result decision logic. Optional
   images are sent only by the the secondary sender worker through its own Graph identity
   and billing gate, after previous receipts reconcile. Unknown sends are
   never retried automatically. A new activation flag
   `WHATSAPP_SECONDARY_AI_MEDIA_ENABLED=false` defaults OFF.
5. **Quiet-hours and replay safety:** both media and follow-up workers
   recheck sender ownership, clinical/staff review, opt-outs, service window,
   and permitted Malaysia hours immediately before attempting Meta sends.
   Media jobs are one-shot with a bounded expiry.

**Do not activate the secondary sender AI media merely because the code exists.** The
operator must first verify the Meta app/subscription, phone and WABA mapping
on an isolated staging environment and explicitly approve possible
service-message charges. Separate real provider receipts are required
before approving the release. Production Neon remains v077 and live Render
auto-deploy remains ON; QA previously rehearsed through v093. The new
migrations v094–099 require a fresh isolated rehearsal and exact-head CI.

## Coexistence production review remediation — 2026-10-23

This supersedes the earlier notes about text-only Business App echoes and
discarded history. Code changes are committed to the **Draft PR**, not live.

- **Migration 096:** `whatsapp_sender_coexistence_media_jobs` holds
  verified Business App echo attachment IDs tied to the saved sender-qualified
  staff message. The fetch-only `whatsappCoexistenceMediaService` worker
  downloads image, video, audio, document and sticker bytes using the secondary sender's
  receiver-specific Meta token and stores them in private R2. It neither sends
  new Cloud API messages nor charges a separate recipient. Failures retain
  the truthful original placeholder and are surfaced to staff for review.
  Bounded GET/download retry is safe; uncertain **outbound** sends are not.
- **Migration 097:** Import audit and per-message passive history provenance.
  History imports may add contacts and historical messages only after
  Meta/business consent and explicit
  `WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=true`.
  Imported user messages are excluded by SQL from the secondary sender service-window
  calculations and the 2h/6h/20h follow-up scheduler; history cannot
  initiate AI replies or grant promotional consent.
- **Migration 098:** Idempotent, sender-qualified Business App text-edit and
  revoke records. These update the ORIGINAL verified staff message rather
  than making a fake new staff reply. Out-of-order mutations wait for their
  original echo and expire after seven days; they are never outbound sends.
- **Migration 099:** Signed passive history/contact webhook changes are first
  stored in an isolated sender-specific durable queue BEFORE HTTP ACK, then
  imported by a bounded, restart-safe worker. This avoids long Meta callback
  requests, and WAMID/idempotency checks handle replay. Unneeded raw history
  payload is erased immediately on successful import, or after seven days for
  abandoned jobs.
- **the secondary sender AI delivery status:** Automatic result/promo images now initially
  persist as *unknown/unconfirmed*, not as visible successfully sent media.
  Verified WhatsApp WAMIDs and receipts remain the only delivery evidence.
  On uncertain sends, never automatically retry.
- **Review UI:** The Tools page contains an the secondary sender media/history incident
  panel behind the existing Manage Tools permission. It shows unconfirmed
  AI-image jobs, Business App attachment failures and failed/expired history
  imports. There is intentionally **no automatic resend action**.
- **Coexistence collision protection:** the secondary sender AI/follow-up activation now
  requires `WHATSAPP_COEXISTENCE_ENABLED=true` as well as explicit
  sender/content, receipt and billing guards. In-process Business App echoes
  become pending before optional history processing.
- **Read-only Meta preflight:** `whatsapp-sender:verify-dual` additionally
  checks the secondary sender phone `is_on_biz_app=true` and `platform_type=CLOUD_API`.
  It still cannot prove subscriptions to every coexistence webhook field or
  actual delivery. Only signed staging callbacks establish those proofs.

### Optional controls — keep OFF until the owner authorizes staging

```dotenv
WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED=false
WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=false
WHATSAPP_SECONDARY_AI_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_AI_SEND_ENABLED=false
WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=false
WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=false
```

Only after read-only Meta confirmation of the secondary sender's actual coexistence and a
business-authorized privacy review, the sender registry's
`coexistence_enabled` may be enabled for the secondary sender on **isolated staging**.
Never copy secondary credentials into Neutro's token env key. Do not enable
history imports when the WhatsApp Business App owner declined sharing.

**No release guarantee from code alone:** complete two-number signed webhook
and Business App echo testing (including sent media, edit, revoke, opt-in,
replays, late receipts and simultaneous clients), provider billing checks,
and isolated migration 094–099 rehearsal (COMPLETED). Existing production Neon is still
v077. The production-derived QA branch has been verified at v099 (183 contacts retained).
Render auto-deploy on `main` means a merge is a LIVE migration/deploy:
**do not merge** until staging passes and a forward-only rollback plan is
approved. Never run the older v077 app binary against a migrated v099 schema.

### 26 October 2026 safety fixes (Draft only)

- Webhook processing now starts each durably claimed Neutro inbound turn independently of later secondary billing/echo/history failures. Those failures still return 503 so Meta can retry the secondary event without silently discarding it. Simulated mixed-callback regression tests cover receipt, history, echo and secondary inbound failures.
- Meta coexistence subscriptions include `account_update`, `messages`, `history`, `smb_app_state_sync` and `smb_message_echoes`. Any lifecycle event that is not a customer message must never trigger AI, CRM opt-in or sending.
- Secondary onboarding is blocked until an operator verifies **Embedded Signup v4** in the actual Meta Login for Business configuration and explicitly sets `META_EMBEDDED_SIGNUP_V4_CONFIRMED=true`. The flag is an operator attestation, not an API-verification result. Configurations using v2/v3 are no longer acceptable for new onboarding after 15 October 2026.
- An authorization result does not persist a sending token or activate a phone; the authorized account/phone pair, app, callback subscription, coexistence status, privacy and billing authority still require live validation.
- Preserve history-sync setup **before** Business App QR approval because the initial consented sync has a time-limited window. The existing PR395 staging sandbox intentionally refuses provider POSTs and cannot satisfy live acceptance until an independently authorized, provider-enabled environment exists.
- **NOT RELEASED:** This is software hardening, not proof of coexistence or proof that Neutro can never be affected by a shared infrastructure outage. Retain Draft status and production schema v077.

## 26 October 2026 — Post-review fixes, schema 100

The former version 99 release gate is superseded by schema **100**, which adds a separate audit for verified secondary coexistence disconnection events. A signed `account_update` reporting `PARTNER_REMOVED` or `ACCOUNT_OFFBOARDED` can only disable the pinned secondary sender; it cannot modify Neutro's registered primary account. `ACCOUNT_RECONNECTED` does **not** automatically re-enable the sender. Default app-level callbacks and the per-WABA WhatsApp callback both use verified lifecycle routing when correctly configured.

Meta callback processing now applies a bounded deadline to secondary durable work. On a secondary timeout, it preserves Meta retry (HTTP 503) while scheduling already-saved primary messages. A late-completing secondary inbound claim still schedules its own message. This remains a single shared database pool and callback service; it does **not** promise hard isolation from infrastructure-wide outages.

**Remaining external release blockers:** actual DA CHATBOT app ownership/subscription, Embedded Signup v4 configuration verification, a Meta-authorized consented QR session, a signed two-number E2E drill, disconnection and restore checks, separately approved clinic content/billing, and a production-forward migration rehearsal. Current isolated staging blocks provider ingress/outbound. Keep PR #395 Draft until those are complete. Never merge solely because CI passed.

## 26 October 2026 — final production-regression repairs (still Draft)

Critical restart safety: `assertStoredSenderSafety` allows an *exactly identified* secondary account in `disabled` state while keeping its send/AI/workers closed; primary Neutro must remain active. `getContactById` can display a disconnected secondary without authorizing messages. The secondary E164 lifecycle phone pin is now mandatory before any dual Inbox activation.

A repeat signed disconnect, even after manual reactivation, disables the secondary again; distinct account-update `entry.time` values create distinct audit fingerprints. Old replays may suspend conservatively: a human must re-verify before reactivation. Echo-persistence timeouts no longer clear the pending-AI guard until the real operation settles. Other legitimate `account_update` types on the signed default Meta callback are hashed and audited (200), while misrouted message/history events remain retryable (503).

The Inbox displays a suspended number and blocks secondary composer and template entry; the server-side transport continues to verify `state='active'` before any send. No Meta credentials, WhatsApp authorization, production sender state, QR, subscriptions or production migrations were changed by these PR commits. Complete real signed two-number QA and independent commercial/policy authorization before merging.
