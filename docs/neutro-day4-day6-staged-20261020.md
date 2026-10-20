# Neutro Sense — staged day 4/day 6 WhatsApp follow-ups (20 Oct 2026)

## Current production state — KEEP UNCHANGED
- Regular 2h/6h/20h: enabled.
- Extended template slots: [48,66]. 48h `ns_enquiry_reengagement`, 66h `ns_fu2_general_checkin`.
- Strict RM0: disabled. Activation timestamp: null.
- The worker cannot activate 96h/144h while Strict RM0 is disabled, even if the seven-day env flag is true.
- No independently verified post-72h `free_entry_point`, `billable=false` receipt exists as of 20 October 2026.
- Six template variants were **submitted and then verified APPROVED by Meta on 20 October 2026**. They are **not scheduled or enabled**. Approval only authorizes use of the templates, not guaranteed delivery or free billing.
- Historical 10 October billable receipt remains unresolved. The messaging account has a payment method; do not promise zero fees.

## Proposed schedule
- 48h — current `ns_enquiry_reengagement`
- 66h — current `ns_fu2_general_checkin`
- 96h — draft `ns_day4_checkin`: question-oriented gentle check-in
- 144h — draft `ns_day6_invitation`: low-pressure final invitation
- Never run multiple missed slots at once or backfill older conversations.
- Retain 00:00–07:00 MYT quiet hours and all existing protections: consent, opt-out, 24h silence after inbound, appointment/visit, human intervention, temperature, billing evidence, previous attempt outcomes, template approval and language. Do not promise clinical outcomes or claim that the paid trial is free.
- Meta provider acceptance alone is not delivery; Meta delivery evidence alone is not pricing proof.
- Both new templates have no media, placeholders, buttons or visible Stop promotions footer; category MARKETING, languages zh_CN, en_US, ms.
- This is a **copy-only** change: retain working inbound marketing opt-out detection, consent enforcement, unsubscribe suppression, and related safety checks. Existing approved 48h/66h template bodies remain unchanged.

## Draft 96h / ns_day4_checkin

### zh_CN
Hi～想再关心一下你之前咨询的护理 😊

如果你还有疑问，例如护理过程、想了解自己的情况，或者想先让中医师评估，都可以直接回复我。我们可以先聊清楚，不需要急着决定。


### en_US
Hi~ Just checking in about the treatment you enquired about 😊

If you still have questions about the process or would like our TCM practitioner to understand your concerns before an assessment, feel free to reply. There's no rush to decide.


### ms
Hai~ Nak tanya khabar tentang rawatan yang anda pernah tanya 😊

Kalau masih ada soalan tentang proses rawatan atau nak tabib TCM fahamkan keadaan anda sebelum penilaian, boleh balas mesej ini. Tak perlu buat keputusan sekarang.


## Draft 144h / ns_day6_invitation

### zh_CN
Hi～如果你之后还想了解之前问的护理，随时找我们就好 😊

想询问收费、了解评估或体验，或者安排合适的时间，都可以直接回复这里。方便的时候再聊，不急哦。


### en_US
Hi~ We're here if you'd like to continue the conversation about the treatment you asked us about 😊

Feel free to reply anytime to ask about current pricing, an assessment or trial, or a suitable time to visit. No rush at all.


### ms
Hai~ Kalau nak tahu lagi tentang rawatan yang pernah anda tanya, boleh balas mesej ini bila-bila masa 😊

Boleh tanya harga semasa, penilaian atau sesi percubaan, atau masa yang sesuai untuk datang. Tak perlu tergesa-gesa.


## Approved Meta template IDs (still INACTIVE)
- ns_day4_checkin: zh_CN `1435254485366265`; en_US `4570871286487882`; ms `1407915471017988`.
- ns_day6_invitation: zh_CN `1772823270653473`; en_US `28000490849627139`; ms `2164038377822531`.
- All six verified APPROVED as MARKETING, without a visible unsubscribe footer. The chatbot's opt-out processing and marketing-consent checks are unchanged.
- Approval independently verified for all six language variants. Meta template approval is NOT message delivery or billing evidence.

## Proposed FUTURE config patch (do not execute without approval)

Preserve all other clinic_config fields. Once all six Meta templates are APPROVED and billing verification is complete, extend ONLY `automatedFollowUp.freeEntry` by adding slots 96 and 144 and wildcard rules:
```json
{
  "slotsHours": [48, 66, 96, 144],
  "templateRulesAdditional": [
    {
      "slotHours": 96,
      "serviceName": "*",
      "templateName": "ns_day4_checkin",
      "mediaKey": "",
      "mediaUrl": "",
      "videoCodecVerified": false
    },
    {
      "slotHours": 144,
      "serviceName": "*",
      "templateName": "ns_day6_invitation",
      "mediaKey": "",
      "mediaUrl": "",
      "videoCodecVerified": false
    }
  ]
}
```
Do not replace existing 48h/66h rules. Config change must be a deliberate later rollout with activation/backfill audit.

## Activation prerequisites
1. Explicitly approve and submit six marketing templates, then verify all six APPROVED.
2. Resolve the historic billable callback in Meta Billing Hub.
3. Review impact of Strict RM0 and enable only on explicit instruction; this can block legitimate replies.
4. Verify an independent, qualified >72-hour `free_entry_point`, `billable=false` provider callback on Neutro's own account, not attributable to a newer paid ad re-entry. **Never initiate a potentially paid customer message merely to create proof.**
5. After evidence exists, verify `WHATSAPP_FEP_7DAY_VERIFIED=true` and test inactive candidate eligibility, 1h safety buffer, quiet-hour behavior, disabled/failed DB paths, billable receipt halts, template locale and opt-outs.
6. Enable 96/144 only in a separately reviewed rollout. Observe accepted, delivered/read, and billable=false receipts distinctly.
