# Phase B: reuse the existing secondary follow-up worker

**GitHub only, draft. Do not activate or deploy.**

This adds no second Neutro AI engine, no second Render instance, no additional
database tables, and no polling loop. The existing
`whatsappSecondaryFollowUpService`, sender-specific rules and one-shot attempt
ledger are reused.

- The same paid live automation mode introduced in Phase A now allows a
  separately disabled `WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED` flag.
- Follow-ups require `WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED`, signed
  receipts and separately verified sender/billing prerequisites.
- Initial allowed follow-up is **text-only**, within the 24-hour customer
  service window. Media rules are skipped without consuming a claim when
  `WHATSAPP_SECONDARY_AI_MEDIA_ENABLED` remains OFF.
- DA CHATBOT manual Inbox sending, templates and secondary media remain OFF.
- Follow-ups are selected from **new** non-imported user messages, exact
  sender-conversation mapping, active AI ownership, active opted-in latest
  lead, no opt-out, no newer customer question or Business App staff reply,
  quiet hours and one-shot idempotency constraints.
- Meta ambiguity keeps the sender billing attempt unresolved. No automatic
  retry or forced alarm clearing is introduced.
- No 48h or 72h template messages are enabled here. They require sender-specific
  approved templates, explicit marketing consent, billing safeguards and
  separate live testing.

## Original 29 October unknown send
Read-only Neon checks on 30 October confirmed contact 995 was deleted via
a completed **manual** privacy purge job (id 5) at 15:18:20-21 UTC.
The deletion code retained the reservation's SHA-256 audit,
`previous_state='unknown'`, and a
`purged_unresolved_reservation` sender-wide alarm. The imported 12,029
historical messages remain. The original Meta delivery is not known and
charges have not been reconciled. **Never clear the alarm or resubmit that
message on the basis of the purge.**

## Production gating
PR #438 must first be deployed and signed callbacks verified after Render's
build limit refresh. Then reconcile the original ambiguous send with the
recipient/Business App/Meta charges, and test Phase A on a new controlled
inbound. Phase B stays OFF until independently approved.

Test text-only follow-ups with one new consented customer conversation and
monitor sender attribution and charges. Do not enable pre-existing 2h/6h
video rules or 48h/72h approved templates during this phase.
