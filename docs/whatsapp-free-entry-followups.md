# WhatsApp free-entry extended follow-ups

Meta's Click-to-WhatsApp free-entry billing period can run for **up to seven days** for qualifying entries since September 28, 2026. Seven days is a ceiling, not a guaranteed per-lead free quota. Normal free-form WhatsApp messages still close 24 hours after the last customer message. Approved MARKETING templates are required beyond that window.

## Before enabling this feature

1. Keep `WHATSAPP_FEP_FOLLOWUPS_ENABLED=false` on Render during review. The flag is a second hard switch and is disabled by default; no templates are sent by this code until both switches are on.
2. Confirm approved **MARKETING** templates in the connected WABA. Only static templates and the explicitly supported named treatment/promotion templates with deterministic one-field variable replacement are allowed. Choose an approved default MARKETING template, automatic conversation-language selection, an optional approved-language fallback, and optional service-and-day-specific approved templates. Static IMAGE/VIDEO media headers are supported using either a valid HTTPS URL or an existing Follow-up Tools video key stored privately in R2. The worker does not generate AI copy or upload/transcode media on Render.
3. Confirm customer marketing consent is appropriately captured: their contact has explicit `whatsapp_opt_in_at` and `whatsapp_opt_in_source`, and their current lead is `marketing_consent='opted_in'`. Click-to-WhatsApp alone does not constitute all-purpose marketing consent.
4. Confirm incoming WhatsApp delivery-status callbacks contain `pricing.type='free_entry_point'` for the first qualifying business response. Historical attributions are intentionally not backfilled or assumed eligible.
5. Under **Tools > Automated follow-up > WhatsApp ad leads**, turn on the extended follow-up switch, select template name, language and schedule, and save. Enabling starts a fresh activation timestamp, so it does not send templates to older leads.
6. Only when you understand that provider billing can change before a callback is received, turn on the Render flag `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` and restart the service. There is no direct per-lead free-until API that can guarantee zero charges before every send.
7. Monitor `whatsapp_free_entry_followup_attempts` and `whatsapp_free_entry_pricing_evidence`. Turn off the Render flag to stop the worker immediately on the next process run or reset the tool toggle to stop sends without a restart.

## Safety and scope

- The existing 24-hour automated Follow-up Tools and pricing reminders are unchanged.
- The extended worker only considers WhatsApp contacts whose first-touch attribution is a WhatsApp advertisement, and whose first business response occurred within 24 hours and after the feature was activated.
- It requires an observed `free_entry_point` and non-billable status for that first reply, an unclosed CRM lead with an explicit marketing opt-in, a renewed 24-hour silence period after the customer's latest message, no booking, no *actual staff account* reply after the original business response, no outstanding attention flag, and no opt-out. Existing automated follow-ups are not treated as staff responses.
- The window is capped at seven days after the qualifying business response, with a one-hour safety buffer.
- Each slot is claimed once before contacting Meta. Failed and uncertain sends are not automatically resent. The system refuses to send more templates when a previous attempt has been reported billable.
- Quiet hours and provider/template approval are checked. If the final follow-up would otherwise fall within quiet hours and miss the maximum free-entry deadline, its eligible due time is advanced to just before quiet hours, subject to the 24-hour window and five-hour minimum message spacing. A missed slot is not aggressively made up after 12 hours. Staff can still send through their normal authorized workflow.
- Scheduling six follow-ups may be too frequent for some clinics; the narrower four-slot option is generally gentler. Test with a small group of opted-in customers before full activation.

## Configuration

`automatedFollowUp.freeEntry` is stored in normal clinic configuration:

```json
{
  "enabled": false,
  "templateName": "lead_follow_up",
  "language": "auto",
  "fallbackLanguage": "zh_CN",
  "slotsHours": [26, 50, 74, 98, 122, 162],
  "templateRules": [
    {
      "slotHours": 50,
      "serviceName": "骨盆调理",
      "templateName": "ns_pelvis_followup_video",
      "mediaUrl": "",
      "mediaKey": "CLIENT_OWNED_FOLLOW_UP_MP4_KEY"
    }
  ]
}
```

The service calculates `activatedAt` on enable or schedule/template changes, and sets it to null when disabled. Slots count hours from the first qualifying business reply, not from the first ad click or last inbound message. The oldest supported cap for conversations before the September 28 change remains 72 hours, though no historical activation is performed.

**Important:** Neither Click-to-WhatsApp attribution nor an earlier free callback proves that future sends will not be charged. Meta's eventual billing callback is authoritative after sending. There is no strictly risk-free way to promise zero charges for future Cloud API marketing templates.

## Staff workflow and diagnostics

- A Click-to-WhatsApp ad alone is **not marketing consent**. Staff can record the customer's independently verified marketing agreement, with source details, in the WhatsApp template modal. Confirming marketing updates WhatsApp opt-in and CRM consent in one database transaction and logs a consent event. Never bulk-convert existing contacts.
- Follow-up Tools now shows per-contact eligibility reasons and approximate 7-day ceiling (Malaysia time), plus last skip reason for unsupported approved media or language. Contacts without consent/confirmed billing are not automatically sent.
- Candidate pages continue beyond the first 20 contacts so missing template variants cannot starve later leads. Incomplete or uncertain sends halt further extended templates for that lead.
- Media uploaded in existing Follow-up Tools can be referenced by its shared R2 video key. The worker signs a short-lived private URL per send and does not perform compression in Render. Public HTTPS media must already meet Meta file and codec limits.
- Approved language variants of the **same** template name are used for fallback. For the specifically supported automated treatment and promotion templates, each language's one body variable is computed from the current service/package; the correct currently active clinic promo graphic is uploaded as its IMAGE header. Ambiguous pelvis Package A/B selection or ineligible meridian gift is skipped, never guessed. Arbitrary variable templates are refused. If approved media or language is unavailable, If none is approved or the media header does not match, the follow-up is skipped and the reason is shown in staff diagnostics.
- Migration 054 records Meta billing and attempts, 055 records verified marketing consent, and 056 records non-sending skip reasons. Production activation remains **disabled** until deliberately enabled with `WHATSAPP_FEP_FOLLOWUPS_ENABLED=true` and the clinic Tools switch.

## Account-specific billing verification and repeat ad entries

- The extended 7-day window rolls out progressively. **The default worker ceiling is 72 hours** even on a post-September-28 Click-to-WhatsApp lead. Enable `WHATSAPP_FEP_7DAY_VERIFIED=true` only after a controlled, genuinely qualifying ad chat on this exact account has received a post-72-hour `free_entry_point`, `billable=false` status. This does not guarantee every future message is free; billing is evaluated from callbacks after provider acceptance.
- An existing customer's *new* Click-to-WhatsApp ad message is written as a new `whatsapp_free_entry_referrals` record. It does not overwrite their CRM first-touch source or consent. The worker starts from the chronologically latest recorded referral with its **own** first business response and free-entry pricing evidence. Old chats are never backfilled as verified referrals.
- Ordinary Inbox Retry explicitly refuses extended automatic templates after failure/unknown. Unknown could mean the provider already accepted the message, and the stored signed media URL may have expired. Staff may inspect the delivery callback, then open the template picker to start a **new**, policy-checked template send only with fresh marketing permission and an understanding that it may be billable.
- All extended messages are stored with `is_automated_follow_up=true` and no synthetic staff username. Inbox distinguishes these from human sends. Contact-wide diagnostics require the View all leads permission as well as Manage automation tools.
- Migration **057** records real CTWA referrals. The worker requires it, in addition to migrations 054–056.

## Repeat-ad safety, content and media validation

- A `free_entry_point` callback on another ad click does **not** prove the clock restarted. Chronologically overlapping verified replies share the FIRST free-entry epoch and expiry. A new verified epoch can start only after the prior one expires. An unconfirmed new click cannot hide an older active period.
- Treatment matching prioritizes customer's latest unambiguous service request in the newest ad enquiry, then that ad's name/headline; never silently use a previous journey's CRM treatment. 3D + 9D remains a separate combined service. Unidentified interests use the generic template.
- Maximum **three different** approved extended templates per verified period. Already accepted template names are not sent again; unavailable distinct content is skipped and recorded, not replaced with a repeated generic message. Existing 24-hour follow-ups and pricing reminders still enforce five-hour separation.
- Stored IMAGE/VIDEO templates can reference clinic-owned shared R2 JPG, PNG or MP4 keys. Public HTTPS media must be hosted on exact trusted hostnames configured by `WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS`; other public hosts are rejected. Worker checks MIME and Content-Length with short metadata HEAD calls (max 5 MiB IMAGE, max 16 MiB VIDEO), never downloading/compressing on Render.
- MP4 file metadata does not prove its codec. Staff must explicitly confirm the approved video was exported as **H.264 + AAC**, using the checkbox in treatment-template rules; unverified videos are skipped. Meta may still reject incompatible files.
- Staff eligibility totals, per-contact expiry and last skip now refer to the same verified free-entry epoch as the worker, not old or unpriced ad clicks.
