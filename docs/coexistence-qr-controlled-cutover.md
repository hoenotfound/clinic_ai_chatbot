# Coexistence QR trial: no-loss, rollback-first operator sequence
**Status: NOT CLEARED FOR QR. This is a checklist, not an automated cutover.**

## Current verified snapshot (28 October 2026)
- Meta app `1029862536608134` subscribed to all five required Coexistence fields, plus operational fields (owner dashboard and signed-in Graph Explorer).
- Existing Neutro WABA `1593376338308612`, phone ID `1408739622311791`, exact phone `+601130535053`.
- Neutro's WABA and phone callback overrides both remain
  `https://neutrosense.dasmarketingsolution.com/webhook`.
- **Existing app default remains**
  `https://clinic-ai-chatbot.onrender.com/webhook`. Do NOT update until live receiver and rollback are verified.
- Neutro Render paid service `srv-daqd1rp42hec7398itr0`, rollback live SHA
  `c13d82192c5acca938fdf2a6b7da415004f0a46e`,
  production Neon v077 `steep-forest-44509907`.
- Independently isolated QA Neon `wandering-dream-82267835`
  at schema v104, with encrypted capture table, 0 sender rows, hourly
  verified expiry cleanup and 24-hour default (max 72-hour) retention.
- PR #411 and #412 remain **Draft and unmerged**; production code is not deployed.
- Full real Inbox history import/secondary AI or staff sends are NOT in PR #412;
  synthetic signed HTTP + PostgreSQL and passive read-only QA evidence are
  NOT equivalent to live signed Meta delivery.

## Mandatory pre-QR gates — in order
1. Final PR #411/#412 CI fully green, including signed HTTP app-default
   routing and compatibility regression; audit disabled-outbound flags.
2. Rehearse production v077 -> v079 on a **separately authorized temporary
   restored Neon branch**, and boot the v079-compatible rollback app there.
   NEVER roll back a v079 database to literal `c13d821`, which lacks 078/079.
3. Determine exactly which other WABAs use this Meta app default callback.
   Do not strand non-Neutro app subscriptions. Operational app-wide
   account/template/security notices must be saved and reviewed.
4. Deploy PR #411/#412 to the **existing paid Render only after approval**,
   initially with both `WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED` and
   `WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED` OFF. Confirm Neutro
   signed original /webhook receipt, AI replies, templates/media/follow-ups,
   staff Inbox and Meta account/phone callback overrides remain intact.
5. In a controlled cutover window, enable the app-default router and verify a
   signed synthetic HMAC + GET challenge at the exact proposed URL
   `https://neutrosense.dasmarketingsolution.com/whatsapp/default`
   (VERIFY DNS/TLS and route before using). Prove signed primary and lifecycle
   audit, foreign account rejection and rollback to the prior app default.
   Only after this proof, explicitly approve changing Meta's app-default URL.
6. Confirm the customer-owned second WhatsApp Business App number and
   E.164 is NOT Neutro primary and NOT the retired earlier candidate.
   Confirm operator, business, processing and **separate history/contact**
   sharing consent. Test the exact supported phone, app, and admin permissions.
7. Prepare a 24-hour staffed onboarding and one-time sync plan. Ensure
   meta`/smb_app_data` once-only dispatcher/ledger, signed receiver and
   data importer have been rehearsed. Imported history **does not open a
   customer service window**, trigger marketing consent or start AI.
8. If all evidence flags are independently confirmed, obtain **explicit owner
   authorization for the QR and any Meta callback mutation**. Never scan a
   second business phone during an ongoing deployment.

## After scanning QR (before starting one-time data sync)
- Only Meta's `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` session may supply the
  new verified WABA and phone-number IDs. Never fill these from a guessed
  number, prefill, earlier clinic or legacy test account.
- Verify WABA owns phone ID, `is_on_biz_app=true`, Cloud API platform
  type and sender-specific token scope. Save only an authorized credential
  reference, not tokens in logs or the frontend.
- Bind the exact sender ID to isolated QA `sender_key=coexistence_qa`
  in `testing` and enable only the encrypted receive-and-hold flag.
  **Outbound, AI, templates, follow-ups and secondary billing stay OFF.**
- Test an HMAC-signed `messages` webhook and a Business App
  `smb_message_echoes` event via the actual app-default route, verify
  ciphertext is committed to QA and never reaches Neutro AI.
- Operator reviews whether history sharing was granted or explicitly
  declined. Each contact/history sync API is **once-only and must be
  initiated within the 24-hour onboarding window**. Do NOT call it on
  mere QR completion; it requires a validated importer, a durable
  once-only provider request ledger and an explicit second approval.
- Inspect encrypted QA-only passive counters for phases/progress and
  declines; counters **do not prove full import**. Do not acknowledge
  successful customer-history import without evidence of permanent
  sender-scoped records or an explicit no-history decision.

## Emergency rollback
- Do not remove Neutro WABA/phone webhook overrides. They are separate.
- Restore previous Meta app-default callback
  `https://clinic-ai-chatbot.onrender.com/webhook` only after verifying
  that this old service still accepts app-wide lifecycle fields. Neither
  this script nor PR #412 changes Meta automatically.
- Turn OFF secondary QA capture and outbound flags. Preserve Meta error codes
  and sanitized event fingerprints, not customer payloads.
- If the production DB has crossed migration 079, restore the dedicated
  `safety/neutro-cloudapi-rollback-v079-20261028` source tree,
  NOT literal old live SHA. Verify code/DB history compatibility first.
- An account partially paired to Coexistence might require Meta-led
  offboarding/re-onboarding; changing a callback is NOT equivalent to
  undoing Meta business-app pairing.

### Evidence not yet obtained
Actual other WABA subscription inventory, live paid route signed test,
production-data restored Neon rehearsal, permanent isolated secondary
history importer, verified second Meta identity, sender-specific
Meta permissions and once-only history/contact sync dispatcher.

The QR is a real Meta onboarding transaction, not a harmless visual preview.
Do not use it until all preflight gates pass.
