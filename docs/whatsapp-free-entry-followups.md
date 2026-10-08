# WhatsApp free-entry extended follow-ups

Meta's Click-to-WhatsApp free-entry billing period can run for **up to seven days** for qualifying entries since September 28, 2026. Seven days is a ceiling, not a guaranteed per-lead free quota. Normal free-form WhatsApp messages still close 24 hours after the last customer message. Approved MARKETING templates are required beyond that window.

## Before enabling this feature

1. Keep `WHATSAPP_FEP_FOLLOWUPS_ENABLED=false` on Render during review. The flag is a second hard switch and is disabled by default; no templates are sent by this code until both switches are on.
2. Confirm approved **static, no-variable MARKETING** templates in the connected WABA. This initial version uses one fixed template and language for all extended slots. It does not attach testimonial media or generate AI copy.
3. Confirm customer marketing consent is appropriately captured: their contact has explicit `whatsapp_opt_in_at` and `whatsapp_opt_in_source`, and their current lead is `marketing_consent='opted_in'`. Click-to-WhatsApp alone does not constitute all-purpose marketing consent.
4. Confirm incoming WhatsApp delivery-status callbacks contain `pricing.type='free_entry_point'` for the first qualifying business response. Historical attributions are intentionally not backfilled or assumed eligible.
5. Under **Tools > Automated follow-up > WhatsApp ad leads**, turn on the extended follow-up switch, select template name, language and schedule, and save. Enabling starts a fresh activation timestamp, so it does not send templates to older leads.
6. Only when you understand that provider billing can change before a callback is received, turn on the Render flag `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` and restart the service. There is no direct per-lead free-until API that can guarantee zero charges before every send.
7. Monitor `whatsapp_free_entry_followup_attempts` and `whatsapp_free_entry_pricing_evidence`. Turn off the Render flag to stop the worker immediately on the next process run or reset the tool toggle to stop sends without a restart.

## Safety and scope

- The existing 24-hour automated Follow-up Tools and pricing reminders are unchanged.
- The extended worker only considers WhatsApp contacts whose first-touch attribution is a WhatsApp advertisement, and whose first business response occurred within 24 hours and after the feature was activated.
- It requires an observed `free_entry_point` and non-billable status for that first reply, an unclosed CRM lead with an appropriate marketing opt-in, no customer reply since the initial response, no booking, no manual takeover, no outstanding attention flag, and no opt-out.
- The window is capped at seven days after the qualifying business response, with a one-hour safety buffer.
- Each slot is claimed once before contacting Meta. Failed and uncertain sends are not automatically resent. The system refuses to send more templates when a previous attempt has been reported billable.
- Quiet hours and provider/template approval are checked. A missed slot is not aggressively made up after 12 hours. Staff can still send through their normal authorized workflow.
- Scheduling six follow-ups may be too frequent for some clinics; the narrower four-slot option is generally gentler. Test with a small group of opted-in customers before full activation.

## Configuration

`automatedFollowUp.freeEntry` is stored in normal clinic configuration:

```json
{
  "enabled": false,
  "templateName": "lead_follow_up",
  "language": "zh_CN",
  "slotsHours": [26, 50, 74, 98, 122, 146]
}
```

The service calculates `activatedAt` on enable or schedule/template changes, and sets it to null when disabled. Slots count hours from the first qualifying business reply, not from the first ad click or last inbound message. The oldest supported cap for conversations before the September 28 change remains 72 hours, though no historical activation is performed.

**Important:** Neither Click-to-WhatsApp attribution nor an earlier free callback proves that future sends will not be charged. Meta's eventual billing callback is authoritative after sending. There is no strictly risk-free way to promise zero charges for future Cloud API marketing templates.
