# Neutro secondary WhatsApp: Chinese / English 48h and 72h follow-ups

**Code only; no production deployment, rule activation, recipient sends or billing reconciliation.**

## Why this change
The original secondary 48h/72h MARKETING worker permitted only one fixed language per time slot.
A Chinese customer could receive the English slot template (or vice versa), despite both templates being approved.

## Implementation
- Forward-only migration **111** extends the existing secondary MARKETING rule key from
  `(sender_id,slot_hours)` to `(sender_id,slot_hours,language_code)`. It preserves existing rows,
  approvals and all attempts. It does not create or enable rules.
- Each 48h and 72h slot can now store independent, exact **Meta APPROVED**, text-only MARKETING
  templates for Chinese (`zh_CN`) and English (`en_US`). The management UI allows enabling
  only the selected language(s) with explicit billed-MARKETING approval, and the server saves
  the entire slot atomically; removing a language disables it rather than deleting audit rows.
- The scheduler uses only the eight most recent sender-qualified, non-imported **customer**
  message texts and the existing `chatLanguage` detector, which recognizes explicit language
  requests and distinguishes Chinese, English and Malay. No extra AI or new worker.
- If the detected language is unknown or the matching locale is not configured, **skip**.
  Do not send the wrong language, translate an unapproved template, or silently fall back.
  Malay (`ms_MY`) is recognized but stays unsent until separately approved and configured.
- The one-shot attempt key remains `(sender, contact, inbound, slot)`, **not** language,
  so switching languages cannot cause duplicate sends or extra charges.
- Recheck the selected language, signed sender and exact Meta template name, locale, signature
  and rule version before send. The existing billing gate verifies the same template variant.

## Available approved account templates, confirmed 30 October 2026
- 48h: `ns_48h_choice_v2`, `zh_CN` and `en_US`.
- 72h slot: `ns_66h_assessment_v2`, `zh_CN` and `en_US`.
  **The existing template name says 66h, but the independent worker is scheduled at 72h.**
  Staff should review/approve that wording and timing rather than assume equivalence.
- Pricing-image templates have a variable and IMAGE header and remain **ineligible**
  for this text-only scheduled worker.

## Activation after tomorrow's deploy
1. Deploy reviewed main with *all secondary outbound OFF*, apply migrations through 111.
   Check primary WhatsApp, Messenger and Inbox before any secondary activation.
2. Add second-account Meta payment method and separately resolve the old UNKNOWN billing
   alarm through audited manual review. Never resend the historical unknown message.
3. Verify signed secondary incoming and pricing/delivery receipts, coexistence echoes,
   correct sender routing and fresh new CTWA ads-only contact selection.
4. In Secondary Follow-up Tools, select and independently approve the Chinese and English
   text templates for each slot; enable only after second-account marketing consent,
   booking/staff and charge gates have been verified.
5. Use supervised new ad leads to test both languages and unknown/Malay exclusion.
   Verify one accepted send at most per time slot and signed billing receipts.

**Safety:** no automatic sends to imported/existing/direct secondary contacts. No primary
WhatsApp, Messenger, Instagram, template credentials, consent or billing data is reused.
