# PR #414: production pre-QR release gates (28 October 2026)

**Decision: QA history handoff PASSED, production release NOT yet authorized,
QR NO-GO until preflight completes.**

## Evidence already verified

- Draft PR [#414](https://github.com/hoenotfound/clinic_ai_chatbot/pull/414),
  branch `pr395-history-handoff-20261028`, commit `3c4771d0`.
  Full CI and focused disposable-Postgres tests passed.
- Staging Render `srv-dbdgmnks728c73btahcg` runs the candidate branch,
  auto deploy OFF. One-shot synthetic history handoff passed on this live
  staging service, using the real QA Neon source and destination.
- QA source Neon project `wandering-dream-82267835` database `neondb`
  still has **schema 104**. QA Inbox destination `pr414_forward_qa`
  has **schema 106**. Both were confirmed clean after synthetic fixture
  cleanup (all sender, contact, message, capture, sync and import-job counts
  zero). The temporary test execution flags were then turned off.
- Paid Neutro Render `srv-daqd1rp42hec7398itr0` still runs
  `main` commit `c567e05ba4`, auto deploy OFF. Production Neon project
  `steep-forest-44509907` remains at migration **079**, with **221**
  WhatsApp contacts and **2,996** messages total at the preflight read.
  No production merge, deploy, flag change or database migration occurred.

## Mandatory gates before QR scan

1. **Release authorization and backup:** Obtain explicit operator approval
   for deploying the reviewed PR #414 to the paid service and adding migrations
   080–106. Take/verify a recoverable Neon point-in-time backup or safe
   restore position. The production DB is not the old QA v104 branch: never
   copy old QA migration metadata into production.
2. **Production regression check:** Review the PR's 69 changed backend files,
   including primary `/webhook`, `/whatsapp/default`, Messenger/IG, sender
   identity, billing and follow-ups. CI passing does not replace a supervised
   deployed primary-number smoke test.
3. **Controlled deployment:** Merge only after approval. Deploy the exact
   reviewed `main` commit to the *paid* Render, with all secondary
   outbound, AI, templates, billing reservations, sync-dispatch and capture
   **OFF**. Run the normal versioned migration runner against production
   v079 to v106. Confirm no legacy rows or identities were reassigned.
   Never switch the paid service to the old QA v104 database.
4. **Primary health:** Verify Neutro Cloud API incoming/outgoing WhatsApp,
   FB Messenger, IG, Inbox and customer context, images, pricing, automation,
   follow-ups and approved templates after the deploy. Confirm Render is live,
   errors stable, and existing customer records unchanged. If any primary
   regression occurs, stop secondary activation; do not blindly roll back
   production schema.
5. **Meta read-only checks:** Confirm Meta app `1029862536608134`
   app-default is still
   `https://neutrosense.dasmarketingsolution.com/whatsapp/default`,
   primary Neutro WABA and phone overrides still use
   `https://neutrosense.dasmarketingsolution.com/webhook`, relevant
   fields include `messages`, `history`, `smb_app_state_sync`,
   `smb_message_echoes` and `account_update`. Confirm live signed
   POST delivery for an independently verifiable noncustomer lifecycle
   test if safely available. **Existing connected WhatsApp Business admin
   account does not administer this Meta app**, so the connector cannot
   independently attest this configuration. Do not confuse an owner-confirmed
   dashboard URL with proven actual delivery.
6. **Post-signup handoff operators ready:** The intended number is
   `+60174831336`, but never guess its WABA or phone ID. Keep a supervised
   operator available to pin Meta-issued IDs immediately after QR, set
   sender-scoped source and destination states, verify registration and
   signature, record separate consent to share contacts/history and
   request the once-only history sync inside the provider's allowed time
   window. Do not send real history or sign up before the exact receiver,
   durable importer and operational instructions are verified.

**Never perform these without separate explicit authorization:** real QR,
Meta subscription/callback mutation, production merge/deploy, real
`smb_app_data` request, secondary customer replies, AI or Meta billable
messages.

**Hard stop:** unknown primary callback change, identity mismatch, missing
history consent, unknown once-only sync result, any Neutro/Messenger delivery
regression or unexpected secondary customer send. Keep all production
customers and Meta secrets out of the isolated QA test datasets.
