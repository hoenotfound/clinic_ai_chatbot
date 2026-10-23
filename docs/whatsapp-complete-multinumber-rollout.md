# DA CHATBOT multi-number WhatsApp — Phase 2 consolidated PR #395

**Status: implementation and isolated database rehearsal completed; LIVE activation not approved.**

All Phase 2 implementation is kept in a single Draft PR #395. Older work
from #384, #387, #389, #391, and #393 is included. No Phase 2 feature
has been merged to `main`, deployed, or enabled in Render.

## Built and sender-isolated

- Existing Neutro WhatsApp number remains the primary, with its current
  Meta token, legacy delivery/billing tables and unchanged content.
- Ariel has a distinct phone-ID-qualified contact identity, Inbox sender
  label/filter, bounded inbound conversation, and sender-specific Graph
  transport. One customer's Neutro and Ariel chats never share a contact.
- Signed webhook partition stages Ariel's delivery/pricing receipts to
  separate tables and rejects mixed/mismatched phone/account evidence.
  Neutro statuses continue through the existing handlers.
- Ariel staff and AI text replies use the verified sender, fresh 24-hour
  window, one-shot saved-message reservation, audited receipt settlement
  and no legacy fallback or automatic retry.
- Ariel staff media uses separate uploads for image, video, audio, document
  and sticker; no Neutro media IDs/cache are reused.
- Ariel templates have their own WABA-approved live catalog, explicit
  opt-in/marketing-consent checks, one-time staff billing-review claim,
  text/image/video components and per-message audited authorized paid
  receipts. Unapproved charges and failed callbacks latch an alarm.
- Each Ariel contact has a separate unresolved billing gate. The global
  sender alarm still halts every Ariel contact after an adverse receipt.
  Nonbillable `free_entry_point` receipts can release the gate when
  explicitly enabled; confirmed staff-approved billable template receipts
  have a separate explicit approval gate. Unknown deliveries cannot be
  retried or cleared automatically.
- Ariel 2h/6h/20h follow-ups use independent **clinic-authored**, sender-
  owned rules with one-shot claims, sender-specific media, opted-in and
  marketing-consent checks, appointment/staff takeover avoidance, 00:00–07:00
  quiet hours, fresh service-window and config revision rechecks.
  **No rules or schedule are seeded by the migration.** A crashed/unknown
  send is never retried automatically. The legacy Neutro worker remains
  separate.
- Generic Inbox retry for Ariel is denied before the primary retry policy.

## Default-off controls

All WhatsApp multi-number flags and Ariel sender-specific switches remain
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
  (`br-steep-flower-b3qayk0r`): migrations v078–093 applied
  successfully and atomically
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

1. Obtain/verify Ariel's real WhatsApp phone number ID, WABA ID, Meta token,
   exact Meta application secret, business portfolio ownership and
   coexistence onboarding. Do not assume the numbers share WABA.
2. Test actual signed inbound/status callbacks for both numbers in a
   **separate staging deployment**; check Meta permission/subscription
   scope and never use production token as an Ariel fallback.
3. Test a staff reply, AI reply, media, template (free and billable), opt-out,
   recipient mismatch, late billable callback, status ordering and concurrent
   contact sends with **real provider receipts** before activation.
4. Configure/approve Ariel's content and follow-up rules explicitly.
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
   exact Meta identities. Check Ariel's inbound while keeping sending OFF.
4. Test staff text, then media, then AI text, then approved templates and
   receipts. Enable only one class of outbound behavior at a time.
5. Do not enable Ariel follow-ups until its own consent and content rules
   have been reviewed. No silent reuse of Neutro scripts or media.
6. Rollback: turn OFF only the new Ariel send/worker flags, maintain
   sender-aware reads once Ariel contacts exist, and preserve the receipt
   and attempt ledgers for reconciliation. Do not force clear ambiguous
   billing reservations.

**NEVER merge an unreviewed migration or switch the production Neon
DATABASE_URL to the QA branch.**


## Review remediation and release constraints (updated after six-area review)

PR #395 remains **Draft** and unmerged; Neutro's production branch remains
unmodified by this remediation. Code changes require **fresh exact-head CI**.

- Corrected Ariel reservation outcome updates to match one sender+contact+
  reservation and require atomic row counts. Tested reversed two-customer
  Meta acceptance order.
- Fixed Ariel media callback invocation, which previously risked sending
  the literal `[staff media]` text, and fixed the unit mock that missed it.
- Primary sender lookup now recovers stored Neutro identity during a read-flag
  rollback. Turning off scoped ingress after Ariel has customers is forbidden;
  leave permanent sender identity enabled and disable Ariel operations.
- Existing Neutro pre-registration delivery jobs can be verified by unique
  primary WAMID ownership and registration time; new untagged jobs fail closed.
- Preserved clinic-wide seven-day CTWA proof **only for Neutro's verified
  primary Meta identity**, while keeping the primary strict-billing gate.
- Meta `free_customer_service` signed nonbillable statuses can settle the
  exact Ariel reservation. Unknown Meta pricing is not treated as free.
- Definite provider HTTP client rejection and network/5xx ambiguity have
  different audit outcomes. Unmatched signed billable receipts hold Ariel;
  nonbillable bounced messages hold only the affected conversation.
- Sender-owned customer deletion now includes sender-specific contact records
  and privacy-minimized billing audit; foreign key cleanup must be regression
  tested against active and settled sends.
- Contact-access authorization and reply permission apply server-side to
  contact-scoped conversation routes; cross-business forwarding is blocked.
- Tools has an Ariel-specific text-only 2h/6h/20h rule editor, backed by its
  own staff-authorized endpoints. No Neutro media/rules are shared.
- Inbox displays separate sender capability and blocks Ariel's legacy retry
  control; Meta billing previews never inherit Neutro's evidence.

**Known external and operational release blockers:**

1. Real Meta coexistence, token identity and signed two-number webhooks
   have not been exercised on staging. Do not infer reliability from CI.
2. The old pre-PR Render application **cannot safely be redeployed** against
   migration 093: the migration runner rejects unknown future versions.
   Only perform a compatible forward fix / disable Ariel feature flags while
   maintaining permanent sender-scoped contact identity.
3. The application's migrations normally commit **per migration**, not as
   one all-or-nothing transaction in production. QA's explicit transaction
   does not change this runtime behavior.
4. Verify real provider pricing and explicitly approve any possible charges
   to Ariel's account. The 24-hour reply window alone **does not prove RM0**.
5. Ariel's AI-specific prompt/pricing/service settings require separate
   clinic approval; do not enable Ariel AI against Neutro's treatment content.
6. Autonomous 48h/72h marketing-template sending is **not implemented** for
   Ariel pending template, consent and billing approval.
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
  required at startup **before any Ariel outbound capability** can be enabled.
  This is an acknowledgement of *potential* charges, not an atomic Meta
  spending limit or proof the current free monthly allowance is unconsumed.
  Keep it FALSE unless a responsible operator approves billing. Meta's
  [official FAQ](https://whatsappbusiness.com/resources/faq/) confirms that
  from 1 October 2026 each phone number gets 1,000 free service messages per
  month, then service messages are charged individually.
- **The operator approved Ariel Lee using exactly the same Neutro Sense
  clinic content**, including the existing AI prompt, business details,
  service catalog, prices and current promotions. The app's existing global
  Neutro clinic configuration is therefore the intentionally shared source.
  To activate *only after staging*, set both
  `WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE=primary` and
  `WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED=true`. Startup and
  runtime guards enforce this explicit binding for Ariel AI.
  This is **content sharing only**: Meta token, business phone ID,
  customer/conversation identities, consent, follow-up ledger and billing
  reservations must remain independent. Pricing/result media are not
  automatically sent by Ariel AI yet: the separate sender media/billing path
  must be verified first. **Ariel AI and follow-ups remain OFF in Render.**
- Live Render `da-chatbot-neutro-sense-tcm` follows `main` with
  **auto-deploy ON**. Do not merge this PR before staged signed Meta
  callbacks, exact credential/number verification, billing consent and a
  separate go-live authorization.
- Ariel Lee's WhatsApp Business App number is registered under the
  Neutro Sense business portfolio. That does **not** prove Meta coexistence,
  a sender-scoped token, or webhook subscription. The linked WhatsApp tools
  cannot inspect DA CHATBOT App `1029862536608134` under that portfolio.
  A client business need not own the developer's Tech Provider app: verify
  the actual authorized subscription and phone/account relationship, but
  do **not** move or connect client business assets solely to satisfy a
  limited connector's permissions.

### Forward-only rollback rehearsal

The real PostgreSQL sender-binding regression now tests all three cases:
(1) disabling Ariel send/AI/follow-up flags while retaining sender-aware
reads and ingress is accepted, (2) disabling sender-aware reads is rejected
when an Ariel contact exists, and (3) disabling scoped ingress is rejected.
The test also checks that the original Neutro message and both contact
records remain intact.

In a deployed failure, switch OFF all Ariel send and worker flags first,
preserve the sender-scoped registry/read/ingress flags and the billing audit
tables, and keep the running application at a version that **knows all
installed migration versions**. Do **not** redeploy the previous 077
binary against database schema 093, manually delete migration history,
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
is never reused for the Ariel account. A shared Meta account is supported
only when both phone IDs are separately proven within it. This preflight
is **not** a substitute for signed incoming/receipt tests and was not
run against live Meta until the correct staging tokens become available.

### What still needs real-world testing

A non-production Render deployment and authorized Meta app must be connected
to an isolated database, a valid shared or separate Meta callback setup and
approved test recipients. Then obtain *actual* signed provider receipts for
Ariel/Neutro inbound, staff text, media, template variables, pricing, wrong
recipient rejection and simultaneous messages. Check billing in Meta's
account UI. These are **not** established by synthetic CI webhook tests and
must not be marked complete without observable provider receipts. The user has approved
Neutro's existing business information, services, pricing, promotions and
clinical escalation content for Ariel Lee's number. Do not invent a second
clinic profile. Sender-specific outbound Meta credentials, billing/receipt
proof, opt-out history and customer context remain separate, and a real Meta
staging run is still mandatory before Ariel AI activation.

**Release decision remains Draft / no live changes.**

## Shared Neutro clinic content decision — 2026-10-23

The business owner has confirmed that Ariel Lee is another WhatsApp number
for the **same Neutro Sense clinic**. The primary clinic configuration,
including services, current pricing, promotions, safety escalation guidance,
and AI conversation prompt, is the authoritative source for both numbers.
Do not maintain duplicate Ariel pricing that can drift from Neutro.

`secondaryUsesPrimaryClinicContent()` now explicitly enforces the approved
`primary` source and separate sender keys in the server's secondary AI
dispatch path and the startup gate. Regression tests prove wrong/missing
approval, missing billing acknowledgment, and missing receipt ingress still
fail closed, while a correctly configured secondary sender can use shared
clinic text without sharing its token or billing state.

**Important:** This removes *only the AI content-isolation obstacle*.
It does not complete real Meta authorization, independent media delivery,
or billing approval. Keep
`WHATSAPP_SECONDARY_AI_SEND_ENABLED=false` and
`WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false` until an isolated staging
deployment has observed correct signed callbacks for BOTH phone numbers.
The existing Ariel follow-up worker still uses its own sender-owned,
staff-authored 2h/6h/20h rules; it does **not** inherit Neutro's scheduling
or send the 48h/72h marketing templates automatically.
