# WhatsApp explicit consent and seven-day follow-up rollout

The opt-in detector only accepts new WhatsApp messages which (1) identify this clinic by name, (2) clearly authorize WhatsApp updates and treatment-related offers, and (3) were actually sent by the customer. The app stores the incoming message ID, provider ID, original wording, timestamp, clinic identity, category, and scope in Neon. An ad click or prefilled draft which was not sent is not consent.

It never updates historic contacts retroactively. Ordinary messages keep the existing 24-hour customer-service follow-ups without a promotional opt-in prompt. Marketing templates outside that window require documented permission. Incoming STOP requests revoke promotional permission and block extended follow-ups; global STOP requires a verified manual re-opt-in. Only a more recent affirmative message can reverse a marketing-only STOP.

## Before enabling extended Click-to-WhatsApp follow-ups

- Confirm the clinic has real customer-sent opt-in evidence; use a voluntary prefilled option without making it mandatory for an enquiry.
- The client Tools `automatedFollowUp.freeEntry` switch and Render `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` are both required. Current Neutro Sense Tools configuration is missing this section.
- Require a NEW incoming Click-to-WhatsApp referral record, first business reply within 24 hours, and Meta's `free_entry_point`, `billable=false` delivery evidence. Never infer a free period from CRM's ad source alone.
- Default to 72 hours until this exact account verifies an after-72-hours nonbillable callback. Only then set `WHATSAPP_FEP_7DAY_VERIFIED=true`. A seven-day maximum is not a guarantee that a given outgoing message is free.
- Use approved MARKETING templates. The current automated worker supports static no-variable templates, so an approved template containing `{{1}}` or an IMAGE header needs a separately-reviewed deterministic variable/media integration or a distinct approved static template.
- Keep five-hour message spacing, quiet hours, opt-out, human takeover, appointment and staff intervention safety rules. Monitor the attempts, skip reasons, pricing evidence and actual Meta delivery callbacks.
- Verify the WhatsApp account's billing/payment configuration before sending messages which might become billable.

There is no automatic activation, no historic consent backfill, and no live customer messaging in this PR.
