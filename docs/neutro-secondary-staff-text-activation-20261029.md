# Neutro second WhatsApp: staff text-only production activation (29 Oct 2026)

## Objective and hard boundary
Enable only staff-authored **freeform text replies** in DA CHATBOT Inbox, sent from 中医养生馆 (`+60174831336`) via its own verified Meta WABA `1852014482431209` and phone ID `1318355951360575`. The primary Neutro Cloud API number and Facebook Messenger remain unchanged. Instagram is not connected.

## Preparation (code merged safely with switches OFF)
The paid app-default webhook uses `whatsappPaidProductionHistoryReceiver` for two distinct modes:
- **History receiver:** import-only, no outbound, explicitly `WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED=true`.
- **Live receiver:** receipt and inbound-only by default; staff text is allowed ONLY when `WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED=true`, history receiver is OFF, and ALL sender-specific sending/billing/receipt safeguards are enabled.

The staff-only receiver refuses AI, media, templates, marketing/follow-ups, automatic reconciliation, QA capture and unapproved staging handoff. All inbound events are still independently HMAC verified and account/phone-pinned. Historical `history`/ `smb_app_state_sync` callbacks are rejected rather than silently lost once the history receiver is OFF.

## BEFORE live activation — non-negotiable gates
1. CI passed on exact merged commit and manual paid Render deployment is healthy. Do not point production to staging Neon or change the WhatsApp primary callback.
2. Verify all 154 import jobs complete, 12,029 historical messages / 7,846 secondary contacts retained, with **no additional pending sync work**.
3. Verify sender registration: primary key `neutro`, secondary key `neutro_secondary`, distinct WABAs/phone IDs, secondary `coexistence_enabled=true`, all secondary conversations bound to sender.
4. Verify the **separate** Meta secondary sending credential: valid and unexpired, with `whatsapp_business_messaging` for the actual secondary WABA/phone. Do not use/copy the primary token. A credential in the encrypted onboarding vault is NOT automatically installed as `WHATSAPP_SECONDARY_TOKEN` for outbound; install a separately verified production secondary token privately in Render (never paste in chat/logs).
5. Obtain explicit operator acknowledgment of possible Meta service-message charges. `WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=true` is an acknowledgment, NOT a cost cap. No assumed RM0 guarantee based on a 24-hour window.
6. Verify receipt ingress is signed, secondary sender-scoped, and alarms/reservations are zero or individually reconciled. Do not clear unknown/ambiguous billing gates to force a send.
7. Have an approved staff-owned test recipient who sends a **new** message to the second number, establishing a fresh WhatsApp 24-hour window. NEVER send to old imported customers for a test.
8. Confirm staff consent and operational readiness to use DA CHATBOT; make only ONE freeform text send to that newly inbound test recipient, reconcile Meta WAMID/receipt before any further sends.

## Atomic Render cutover: do not apply until all checks above pass
On the **existing paid** Render service, update these in ONE environment-variable transaction, not piecemeal:

```env
WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED=false
WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED=true
WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED=true
WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED=true
WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED=true
WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED=true
WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED=true
WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED=true
WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED=true
WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED=true
WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=true
WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED=false
WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED=false
WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED=false
WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_AI_SEND_ENABLED=false
WHATSAPP_SECONDARY_AI_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED=false
WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED=false
WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED=false
WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED=false
WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED=false
```

The following existing values MUST remain unchanged: `WHATSAPP_MULTI_NUMBER_READ_ENABLED=true`, `WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=true`, `WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED=true`, `WHATSAPP_SINGLE_SENDER_STRICT_METADATA=true`, `WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED=true`, the exact primary/secondary Meta sender IDs, verified E164 pins and app HMAC secret. `WHATSAPP_SECONDARY_TOKEN` must be a **private secondary credential**, not from the primary number. Do not log it.

## Safe verification and rollback
- Readiness must stay healthy; primary signed inbound/Cloud API, Messenger and secondary new inbound should still work.
- Before test, verify zero secondary billing alarms, no unresolved reservation and a fresh verified test inbound message.
- First send: one staff-authored short text, no quote/media/templates; compare the resulting WAMID and signed status/billing receipt to the **secondary** phone ID, not the primary.
- On unknown/ambiguous send, **do not retry** until a human verifies the sender's Business App, Meta and billing.
- Rollback only secondary staff send and transport flags, preserving sender-aware reads, secondary inbound, registered contacts, history and the billing ledger. The live receiver can continue with staff-only mode OFF. Do **not** re-enable the one-time history sync dispatch.

No change in this PR automatically enables live messaging or changes Render environment values.
