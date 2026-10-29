# Neutro secondary WhatsApp AI text-only preparation (30 Oct 2026)

**Status:** GitHub development only. **NOT deployed or authorized for production sends.**

## Design

Use the same Neutro AI responder, treatment knowledge, assessment-first
strategy, price clarification and multilingual reply logic as the primary
number. Keep sender-qualified messages, contact state, billing reservations,
phone credentials and Meta receipts separate.

The paid **signed live receiver** now has a third, mutually exclusive mode:

- Passive Inbox only (existing default, no outbound).
- Guarded staff text only (existing, currently OFF in production).
- **AI text only** via `WHATSAPP_PAID_SECONDARY_AI_TEXT_MODE_ENABLED=true`
  *and* `WHATSAPP_SECONDARY_AI_SEND_ENABLED=true`, both default OFF.

AI text-only requires the verified live receiver, distinct pinned WABA and
phone, the secondary token, approved use of Neutro content, Business App
coexistence, signed receipt staging/ingress, policy evaluation, sender-specific
billing reservations, manual reconciliation and explicit possible-charge
acknowledgement. It **forbids** staff Inbox sending, templates, media,
follow-ups and automatic reconciliation. The last option is kept separate
until real receipt settlement has been verified.

No new database migrations, workers, hosting services or polling are needed
for Phase A. The existing inbound WAMID claim, durable outbound-attempt
reservation, Business App echo cancellation and staff ownership check remain
in place. The final provider transport rechecks the bound contact and exact
secondary account/phone/token. Unknown Meta outcomes keep their billing hold;
they are not automatically resent.

Old imported chat history stays passive. In live-only mode a new `history`
event is **rejected**, not sent to the AI processing queue, scored, converted
into a follow-up, or silently acknowledged. The existing imported 12,029
messages must not be modified as part of this release.

## Release blockers and order

1. Leave all production flags unchanged. Deploy merged PR #438 alone after
   Render build minutes refresh and explicit operator approval. Verify real
   signed status delivery before attempting any secondary outbound send.
2. Investigate the missing contact, message and billing records. Confirm the
   original unknown staff text on both recipient and Business App; reconcile
   billing separately and **never retry that original send** automatically.
3. Verify exact secondary registration, account pins and approved Neutro
   content. Check existing primary WhatsApp and Messenger behavior.
4. On a supervised release, deploy this Phase A branch *only after review and
   CI*. Begin with one new controlled inbound test and one AI **text** reply,
   checking Business App echo collision, signed receipts, charge evidence,
   sender attribution, and no second send on a webhook replay.
5. Keep Inbox staff sends, optional media, templates and secondary follow-ups
   OFF. Only after successful live verification should Phase B be considered.

## Phase B, separate review and activation

The repository already contains a secondary-specific follow-up rules table,
attempt ledger, sender-bound selection and worker. Do not enable it as part
of Phase A. Review and separately test historical exclusions, sender-specific
opt-in and opt-out, customer replies, Business App staff echoes, quiet hours,
24-hour window handling, approved templates, media and ambiguity before
enabling a single limited step. The current secondary 2/6/20-hour worker is
not automatically equivalent to Neutro's full 2/6/20/48/72-hour sequence.

No real customer messages were sent in this development change.
