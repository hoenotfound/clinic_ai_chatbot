# Staging-only personal WhatsApp Coexistence live test (PR #415)

**Never run these settings or sender SQL in Neutro production.** Do not merge PR #415 into `main`.
The earlier encrypted history transfer is complete; do not repeat QR onboarding or the once-only sync.

## Phase 0: release checks (read-only)
1. Review the PR's source and tests, and require successful backend CI at the exact final head.
2. Verify staging Render service `srv-dbdgmnks728c73btahcg` uses only the isolated Neon project `wandering-dream-82267835`, target database `pr414_forward_qa`. The historical encrypted QA source is `neondb`. Never use Neutro project `steep-forest-44509907`.
3. Verify the isolated QA sender's real, signup-issued WABA/phone IDs, unchanged Business App coexistence state, token, Meta app HMAC and intended E.164. Never use the clinic test number's IDs.
4. Confirm Neutro's own WABA override remains at `https://neutrosense.dasmarketingsolution.com/webhook` and the app-default lifecycle route remains unchanged.
5. Only after approval, configure **this QA WABA's account-specific callback override**, not the app default or Neutro's override, to `https://da-chatbot-pr395-staging.onrender.com/webhook`. Check Meta subscription GET and signed real POST delivery.

## Phase 1: signed inbound-only acceptance (zero outbound)
1. Keep `PR395_STAGING_MODE=true`, Basic Auth and pinned isolated Neon host.
2. Verify only real QA-number-scoped Meta IDs and E.164 are configured. `WHATSAPP_TOKEN` must be absent or prefixed `pr395-inert-`, never a Neutro production token.
3. Create/verify *metadata-only* primary and already-active secondary sender registry identities **inside isolated QA**. Startup's existing sender-scoped check requires the primary registry row even when primary traffic is excluded; do not insert any primary customer contacts, copy tokens or touch production.
4. Enable the existing inbound-only gate:
```dotenv
PR395_STAGING_PROVIDER_REHEARSAL_ENABLED=true
PR395_STAGING_ALLOW_PROVIDER_PROCESSING=true
WHATSAPP_MULTI_NUMBER_READ_ENABLED=true
WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=true
WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=true
WHATSAPP_COEXISTENCE_ENABLED=true
WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=true
WHATSAPP_SINGLE_SENDER_STRICT_METADATA=true
WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED=true
```
5. **Leave all secondary send, AI, billing reservation, templates and follow-ups OFF**. Confirm the staging preflight and startup succeed.
6. Send one new test message from the approved test phone to the QA Business App number. Confirm a new sender-bound contact/message appears in staging, no assistant message or automatic Meta send, and no Neutro production contact changed. Wrong-WABA and invalid-HMAC callbacks must be rejected.

## Phase 2: one manual staff reply only, after explicit charge approval
The PR provides a narrowly pinned mode; it does **not** enable it by default. Before any staff send, separately approve possible Meta charges and select a single QA recipient phone. Set **only on staging**:
```dotenv
PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED=true
PR395_STAGING_CONTROLLED_STAFF_TEST_OPERATOR_APPROVED=true
PR395_STAGING_CONTROLLED_STAFF_TEST_RECIPIENT_E164=<approved test phone in E164>
PR395_STAGING_APPROVED_TEST_RECIPIENT_E164=<same verified test phone>
WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=true
WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED=true
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=true
WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED=true
WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED=true
WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED=true
WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED=true
WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED=true
```
All other outbound flags remain OFF. In particular **AI, staff media, templates, follow-ups, auto reconciliation, retries and primary sends remain disabled**. Verify sender-scoped policy, open 24-hour service window, secure staff login, receipt ingestion and sender-specific billing attempts. The outbound transport additionally checks the approved recipient before the Graph request and rechecks immediately before sending.

Have an authenticated staging staff member send a single text reply to the QA contact. Inspect the accepted provider WAMID, matching sender/recipient, signed sent/delivered/read receipt and billing record. An ambiguous provider outcome or unknown charge is a STOP; never blindly retry.

## Stop / cleanup
Turn OFF `PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED`, secondary STAFF_SEND and secondary OUTBOUND_TRANSPORT first. Preserve sender-scoped reads, ingress and the existing secondary contact/history bindings. Do not turn off sender-aware ingress on a database populated with secondary contacts. Leave Meta app-default and Neutro overrides unchanged. If QA account override was temporarily set, restore only the previously verified QA-account-specific setting, not other businesses' callbacks.

This PR does NOT enable or test AI replies. That is a separate step requiring explicitly reviewed clinic/generic QA content and an isolated AI-delivery guard. It also does not perform Meta sends, configure paid secrets, modify callbacks or change Neon data.

## Receipt-only QA after the single approved staff reply

After the one-time text reply, turn OFF `PR395_STAGING_CONTROLLED_STAFF_TEST_ENABLED`, its operator approval, `WHATSAPP_SECONDARY_STAFF_SEND_ENABLED`, `WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED`, `WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED`, `WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED`, service-charge acknowledgment and sender token. Keep inbound Coexistence enabled.

To receive **new signed Meta delivery receipts without allowing another send**, staging may set only `WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED=true` and `WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED=true`. Both are OFF by default. Staging startup rejects this mode if any outbound flag, AI, follow-up, payment auto-reconciliation, manual settlement, sending credential or operator billing approval is enabled. This setting never authorizes Meta sends, nor marks an unresolved charge free.

The 29 Oct real QA Meta WAMID ended in Base64 padding `=`; the earlier strict receipt regex rejected it and Meta returned signed callbacks with 503. The corrected validator retains the HMAC check, exact WABA/phone binding, recipient, ID length, and idempotent ledger. The signed raw callbacks were not durably stored, so previously rejected delivery/pricing callbacks may not be recoverable once Meta stops retrying. Do **not** invent, forge, or replay a synthetic receipt for the real billing record; resolve it using independently verified Meta billing evidence and an authorized manual reconciliation workflow. User confirmation of delivery establishes receipt by the phone owner but does not establish Meta billing status.
