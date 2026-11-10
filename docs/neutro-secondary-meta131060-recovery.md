# Neutro secondary: Meta 131060 first-message recovery

## Purpose
The Coexistence number sometimes receives an unreadable Meta 131060 first
message, especially from a first-time Click-to-WhatsApp contact. Meta supplies
no customer text and may supply no referral. No API endpoint can reconstruct
missing webhook text or the original ad ID from this error alone.

## Behaviour
- Secondary Coexistence number only. Primary WhatsApp is unchanged.
- Disabled until BOTH settings are explicitly configured after deployment:
  - WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED=true
  - WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT=<fresh UTC timestamp>
- Requires the existing secondary all-contact text AI activation.
- Only the first signed, sender-bound, post-activation provider message with
  Meta unsupported code 131060 can trigger a recovery request.
- After 3.5 seconds, inspect the saved conversation again. If a readable
  customer message or staff response has arrived, do nothing.
- Reserve the response through the existing durable inbound/outbound attempt
  ledger, and recheck current sender, AI ownership, opt-out, message order,
  service window, billing and staff cancellation immediately before dispatch.
- Send one natural clinic greeting with 3 native WhatsApp reply buttons:
  骨盆调理 / 3D 小颜术 / 9D 逆龄抗衰. More treatments (including 脉冲波)
  remain available by typing a name. WhatsApp only permits three buttons
  in one interactive message.
- A genuine Meta button_reply webhook supplies its ID and readable title,
  so the regular treatment knowledge and AI conversation resume based on the
  customer's explicit selection. A button tap is not evidence of which ad
  the customer clicked and must never upgrade an unattributed CRM lead.
- Do NOT mention WhatsApp errors, AI, unavailable messages or resend,
  and do NOT run Gemini, invent customer content, send prices or Before/After
  media, or treat the placeholder as a follow-up anchor.
- If the signed webhook includes a genuine Meta ad ID and an unambiguous
  treatment in its creative, the greeting may ask about that treatment.
  Otherwise use a short generic Chinese welcome, the secondary sender's default. A readable follow-up resumes normal language routing. Never infer the ad
  from a recent active campaign, prefilled text from an unavailable message,
  or a prior contact's CRM treatment.
- If a subsequent READABLE inbound includes a verified CTWA referral within
  the existing two-minute first-ad proof window, one tracked recovery text is
  neutral for the original first-touch attribution. All other intervening
  messages continue to block that special exception. The normal fixed ad-first
  reply, AI context, result media and promotion rules still apply to the
  actual readable customer enquiry, subject to their normal guards.
- A failed/ambiguous send remains visible through the existing tracked-send
  and staff-attention path. Do not assume that Meta opens a service window
  for every unsupported message; actual acceptance needs live verification.
- No backfill for previous missing messages such as May Pua.

## Verification before enabling in production
1. Check Node tests, PostgreSQL integration tests and PR review.
2. Deploy with recovery disabled, verify the existing main and secondary
   conversations continue normally.
3. Set a fresh UTC activation timestamp and enable only this feature.
4. Send a new first-time CTWA test to the secondary number and inspect the
   webhook: whether the 131060 event included a referral/ad ID.
5. Confirm one native three-button menu at most, the actual Meta delivery
   receipt and sender-specific billing outcome. No send if staff responds first.
6. Select each button from a customer phone. Confirm the signed inbound
   contains the expected interactive button ID/title, AI understands the
   selected treatment, and CRM source remains unattributed unless Meta later
   supplies real ad proof.
7. Also test entering 脉冲波 manually and a customer sending normal text.
   Confirm AI continues normally, without duplicating the first menu.
8. Check that no 2h/6h/20h follow-up or result/price media was triggered by
   the 131060 placeholder.

## Rollback
Set WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED=false.
Do not change the original secondary AI, billing or ad-attribution flags.
