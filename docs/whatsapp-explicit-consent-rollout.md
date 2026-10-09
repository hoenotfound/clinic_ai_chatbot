# WhatsApp explicit consent and seven-day follow-up rollout

The opt-in detector only accepts new WhatsApp messages which (1) identify this clinic by name, (2) clearly authorize WhatsApp updates and treatment-related offers, and (3) were actually sent by the customer. The app stores the incoming message ID, provider ID, original wording, timestamp, clinic identity, category, and scope in Neon. An ad click or prefilled draft which was not sent is not consent.

It never updates historic contacts retroactively. Ordinary messages keep the existing 24-hour customer-service follow-ups without a promotional opt-in prompt. Marketing templates outside that window require documented permission. Incoming STOP requests revoke promotional permission and block extended follow-ups; global STOP requires a verified manual re-opt-in. Only a more recent affirmative message can reverse a marketing-only STOP.

## Before enabling extended Click-to-WhatsApp follow-ups

- Confirm the clinic has real customer-sent opt-in evidence; use a voluntary prefilled option without making it mandatory for an enquiry.
- The client Tools `automatedFollowUp.freeEntry` switch and Render `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` are both required. Current Neutro Sense Tools configuration is missing this section.
- Require a NEW incoming Click-to-WhatsApp referral record, first business reply within 24 hours, and Meta's `free_entry_point`, `billable=false` delivery evidence. Never infer a free period from CRM's ad source alone.
- Default to 72 hours until this exact account verifies an after-72-hours nonbillable callback. Only then set `WHATSAPP_FEP_7DAY_VERIFIED=true`. A seven-day maximum is not a guarantee that a given outgoing message is free.
- Use approved MARKETING templates. The worker now supports static templates and three specially constrained named templates: `ns_fu1_service_checkin` (one treatment-name `{{1}}` variable), `ns_fu_pricing_graphic` (approved promotion image + matching `{{1}}`), and `ns_fu_meridian_gift` (only an active promotion explicitly offering free one-hour meridian massage, with matching image and `{{1}}`). Other arbitrary variable templates remain blocked.
- Keep five-hour message spacing, quiet hours, opt-out, human takeover, appointment and staff intervention safety rules. Monitor the attempts, skip reasons, pricing evidence and actual Meta delivery callbacks.
- Verify the WhatsApp account's billing/payment configuration before sending messages which might become billable.

There is no automatic activation, no historic consent backfill, and no live customer messaging in this PR.

## Resilience and consent-scope rules (PR 284)

- New WhatsApp STOP messages revoke contact and current-lead marketing permission **in the same PostgreSQL statement that durably stores the inbound webhook**. Normal enquiries retain the original lightweight persistence statement. If PostgreSQL rejects the STOP write, the inbound claim fails and Meta can retry; a failed later opt-out write remains a recoverable processing job instead of silently completing.
- STOP detection supports natural, polite Chinese, English and Malay refusals; ordinary price/promotions enquiries are not opt-outs. Message timestamps are checked so delayed processing of an older STOP cannot override a more recent valid opt-in.
- An actual customer-sent, business-named promotional opt-in stores its **specific treatment** (`consent_service`) when identifiable. When a customer starts a new CRM journey, the chatbot only carries forward a still-active, matching scoped opt-in: the customer must still have the same active consent record, must not have opted out, and the new treatment must be identifiable. An unrelated or uncertain service never automatically inherits permission; staff-only confirmations without a message-backed scope never auto-inherit.
- Extended automated image templates reuse a Meta media ID for up to one hour on the **same WhatsApp phone-number ID**. The worker still checks the source promo's current `public_config` purpose, MIME and encoded size before each use; reuse never allows private/result-media files. Cache misses upload an existing validated clinic image without a new R2 object, and explicit send failures invalidate the cached ID.
- Cache entries are bounded to 32 per-process items, not persisted across restarts, and expire automatically. Meta still owns final acceptance/delivery; a positive send response is not a billing-free guarantee.

## Treatment-scoped Marketing checks and configured package aliases

- **Every** WhatsApp MARKETING template with customer-message consent is checked against the event's explicitly identified `consent_service`, the current CRM lead's treatment, and (when the template identifies one) the service being promoted. This also applies if the customer changes treatment on the **same** lead. A saved opt-in without an identifiable treatment is not treated as broad permission. Staff-verified consent recorded as a general Marketing opt-in remains available only for the lead on which staff recorded it, without automatic inheritance.
- At the provider send boundary, the automated follow-up passes the selected treatment to the policy checker again. Staff-chosen configured media also passes its linked service; `ns_fu1_service_checkin` requires the exact service label for the selected language. Generic shared media retains its prior support.
- Pelvis pricing-image selection uses current clinic-configured Package A/B names, titles and aliases, including `A配套`, `A套餐`, `RM488配套`, `B配套`, `B套餐` and `女性护理配套`. Any mention of both packages, conflicting messages, an unrecognized name or missing/expired promotion **skips** automation instead of guessing.
