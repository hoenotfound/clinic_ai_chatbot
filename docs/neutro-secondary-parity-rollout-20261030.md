# Neutro second WhatsApp: parity implementation and staged activation
**Status: source-code draft only. Do not deploy or activate from this PR.**

## Shared clinical and sales behavior
Existing `src/server.js` runs Neutro clinic prompts, multilingual treatment
recognition, assessment-first price clarification, booking/safety/handoff
decisions, lead-scoring hooks, CTWA intent and pricing/result-media selection.
Secondary messages use their own sender-qualified contact, inbox thread,
Meta token, provider media upload, billing gate, signed receipt ledger and
follow-up rules. Imported history never generates an outbound reply.

## New explicit mode
`WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED=false` (default OFF).

The following flags must be inspected **as a group**, never activated one at
a time, and only after the required signed live receiving route is deployed,
provider billing is available, the historical sender-wide alarm is resolved
through the separately approved audit process, and a dedicated owner-approved
new inbound test recipient is available:

- The existing secondary live receiver, sender-aware reads, signed HMAC
  ingress, separate WABA/phone/token, verified clinic-content binding,
  coexistence echo handling, policy and billing reservations are required.
- `WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED=true`,
  `WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED=true`,
  `WHATSAPP_SECONDARY_AI_SEND_ENABLED=true`,
  `WHATSAPP_SECONDARY_STAFF_SEND_ENABLED=true`,
  `WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED=true`.
- `WHATSAPP_SECONDARY_AI_MEDIA_ENABLED` separately enables the AI's existing
  promotion and before/after-result image queue; it rechecks consent,
  cancellation, sender identity and billing before each Meta send.
- `WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED` independently authorizes an
  authenticated staff-sent media item from the Inbox; no AI media rights
  automatically grant staff upload rights.
- `WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED` independently permits STAFF
  templates reviewed against the secondary WABA's own live approved catalog.
  Each template has its own one-time staff billing review and consent check.
  Primary WhatsApp template IDs and Meta media IDs must never be reused.
- `WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED` independently starts consented
  sender-qualified 2/6/20h service-window follow-ups. No history replay,
  no stale contact with later replies, no staff-taken lead, no auto resend.
- The old AI-only and staff-only modes remain valid when parity is OFF.

## Media reuse and privacy
Promotion graphics with configured public HTTPS URLs use the sender-owned
provider transport. Private Settings result images
(`/api/config/result-media/image/<id>`) never use public Meta URL fetch:
the secondary queue loads a matching-purpose private image from Neutro's
database and uploads the bounded JPEG/PNG bytes through its secondary token.

For 2h/6h clinic videos, a Manage Tools operator may explicitly approve a
*configured, namespace-owned clinic follow-up video object*, using
`{mediaKey,mediaType:"video",confirmClinicVideoReuse:true}` on the existing
sender-specific follow-up rule route. The referenced R2 MP4 must exist and
be at most 16 MB. A primary WhatsApp Meta media ID is never reused.
Legacy unnamespaced R2 keys, customer attachments and arbitrary URLs are
rejected. The 20h rule remains text-only; video rules remain disabled if their
source object is not a verified clinic-owned asset.

## What is NOT safe to promise yet
- A 48h/72h *automatic* marketing-template sequence is **NOT implemented**
  by this change. The secondary WABA needs individually APPROVED templates,
  exact treatment-specific opt-in and billing authorization. The existing
  secondary template service supports manual staff-verified sends only.
- The active sender-specific rules in production remain DISABLED until an
  operator separately configures and verifies them. Imported customers do
  not gain opt-in from history import.
- Meta delivery, exact charge, signed callbacks, Business App echo timing,
  voice/media playback, lead-scoring, ads attribution, booking, Telegram,
  staff takeover and post-window templates need REAL end-to-end verification
  with a fresh opted-in secondary-number conversation. CI is not such proof.

## Rollout order
1. Merge only after all GitHub CI/backend/Postgres/browser checks pass;
   keep Render manual deploy, all outbound flags OFF.
2. Deploy to the existing paid service only after the build limit clears.
   Confirm primary WhatsApp and Messenger. Verify signed secondary live
   callbacks and active secondary Meta payment setup.
3. Obtain a separate approval for the audited unknown/unknown recovery of
   the erased historical send; never replay or imply it was free/delivered.
4. Test new secondary inbound, **one AI text** and independent status/billing
   reconciliation. Test staff takeover and one staff text afterward.
5. After media approval, test one configured promotion and one private result
   image, confirming separate Meta IDs and no staff/AI duplicates.
6. Then enable exactly one 2h/6h/20h consented rule and inspect each receipt.
   Do not enable a full template sequence until independently implemented,
   WABA-approved and reviewed.

This PR does not invoke Graph sends, mutate live Neon or update Render.
