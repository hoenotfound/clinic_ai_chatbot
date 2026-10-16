# Neutro Sense: approved Meta video templates at 48h / 66h

Prepared 16 October 2026 for `da-chatbot-neutro-sense-tcm` ONLY. This is **not a database migration** and **must not be executed before this PR is merged, deployed, and its tests pass**. The reviewed, approved WhatsApp Marketing templates are already present; do not resubmit them to Meta.

## Intended selection

| Stage | Treatment | Approved Meta template | Clinic R2 content |
|---|---|---|---|
| 48h | 骨盆调理 | `ns_pelvis_followup_video` (zh_CN) | FU1 pelvis explanation video |
| 48h | 3D 小颜术 | `ns_fu3_face_feedback` (zh_CN/en) | 3D FU2 face experience video |
| 48h | 9D 逆龄抗衰 | `ns_fu3_face_feedback` (zh_CN/en) | 9D FU2 face experience video |
| 48h | 3D + 9D 组合 | `ns_fu3_face_feedback` (zh_CN/en) | Combination FU2 face experience video |
| 48h | Other/unidentified | `ns_enquiry_reengagement` | text |
| 66h | 骨盆调理 | `ns_fu3_pelvis_feedback` (zh_CN/en) | FU2 pelvis testimonial video |
| 66h | Other | `ns_fu2_general_checkin` | text |

All five existing R2 paths were verified as MP4 objects of less than 16 MiB on 16 October. The 3D, 9D and combined face files have the same R2 ETag and length and must count as the **same video content** for duplicate checks.

**Important:** Neutro also sends the pelvis videos at 2h and 6h, and the shared face video at 6h. Most customers who received those messages must **get a distinct approved text template, not a repeated video**, at 48h or 66h. The templates only send video if the customer has not already received the relevant content and all safety gates pass. Existing follow-up videos, quiet hours, consent, appointment/staff deferral, provider pricing checks, and the strict free-entry budget gate are unchanged.

## Deployment and verification

1. Merge the PR and deploy the new main to `da-chatbot-neutro-sense-tcm`.
2. Confirm the reviewed `clinic_config` snapshot still has exactly two wildcard rules (48h and 66h) and slot hours `[48,66]`. The activation query below uses a compare-and-set guard and returns zero rows if that has changed.
3. Execute the activation SQL **only in Neon project `steep-forest-44509907`** after confirming deployment, and verify one updated row.
4. Verify logs for a fresh consenting CTWA pelvis and face enquiry; inspect accepted extended attempt, template name, language, source R2 key, provider delivery state and absence of duplicates. Do not force-send to past customers or clear attempts.
5. Keep the existing 48h/66h billing ceiling and `WHATSAPP_FEP_7DAY_VERIFIED=false`. A Meta-approved template does not itself prove the send is free. If the pricing callback is absent, the worker must refuse to send.

### Activate (after deployment only)

```sql
UPDATE clinic_config
SET data = jsonb_set(data, '{automatedFollowUp,freeEntry,templateRules}',
  $target_rules$[
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "*",
    "templateName": "ns_enquiry_reengagement",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360197056-3181b46c-333c-4cb9-9482-e0c3932a2447.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "骨盆调理",
    "templateName": "ns_pelvis_followup_video",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360472371-8ea0c47a-bc6c-404c-8ba9-3d4849e147c5.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "3D 小颜术",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360484083-f155571a-8bd1-4c9e-9b6f-5c44036014e8.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "9D 逆龄抗衰",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360497668-cea7f554-0149-4899-ac01-8115b9398d21.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "3D + 9D 组合",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "*",
    "templateName": "ns_fu2_general_checkin",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360287656-b8a632b1-ca78-416b-b0ba-a89887898f07.mp4",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "骨盆调理",
    "templateName": "ns_fu3_pelvis_feedback",
    "videoCodecVerified": true
  }
]$target_rules$::jsonb, false),
    updated_at = now()
WHERE id=1
  AND data #> '{automatedFollowUp,freeEntry,slotsHours}' = '[48,66]'::jsonb
  AND data #> '{automatedFollowUp,freeEntry,templateRules}' =
    $prior_rules$[
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "*",
    "templateName": "ns_enquiry_reengagement",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "*",
    "templateName": "ns_fu2_general_checkin",
    "videoCodecVerified": false
  }
]$prior_rules$::jsonb
  AND data #>> '{automatedFollowUp,freeEntry,enabled}' = 'true'
RETURNING updated_at, data #> '{automatedFollowUp,freeEntry,templateRules}' AS active_rules;
```

### Roll back to current text-only rules (if needed)

```sql
UPDATE clinic_config
SET data = jsonb_set(data, '{automatedFollowUp,freeEntry,templateRules}',
  $target_rules$[
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "*",
    "templateName": "ns_enquiry_reengagement",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "*",
    "templateName": "ns_fu2_general_checkin",
    "videoCodecVerified": false
  }
]$target_rules$::jsonb, false),
    updated_at = now()
WHERE id=1
  AND data #> '{automatedFollowUp,freeEntry,slotsHours}' = '[48,66]'::jsonb
  AND data #> '{automatedFollowUp,freeEntry,templateRules}' =
    $prior_rules$[
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "*",
    "templateName": "ns_enquiry_reengagement",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360197056-3181b46c-333c-4cb9-9482-e0c3932a2447.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "骨盆调理",
    "templateName": "ns_pelvis_followup_video",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360472371-8ea0c47a-bc6c-404c-8ba9-3d4849e147c5.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "3D 小颜术",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360484083-f155571a-8bd1-4c9e-9b6f-5c44036014e8.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "9D 逆龄抗衰",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360497668-cea7f554-0149-4899-ac01-8115b9398d21.mp4",
    "mediaUrl": "",
    "slotHours": 48,
    "serviceName": "3D + 9D 组合",
    "templateName": "ns_fu3_face_feedback",
    "videoCodecVerified": true
  },
  {
    "mediaKey": "",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "*",
    "templateName": "ns_fu2_general_checkin",
    "videoCodecVerified": false
  },
  {
    "mediaKey": "clients/neutro-sense-tcm/messages/follow-up-config/1791360287656-b8a632b1-ca78-416b-b0ba-a89887898f07.mp4",
    "mediaUrl": "",
    "slotHours": 66,
    "serviceName": "骨盆调理",
    "templateName": "ns_fu3_pelvis_feedback",
    "videoCodecVerified": true
  }
]$prior_rules$::jsonb
  AND data #>> '{automatedFollowUp,freeEntry,enabled}' = 'true'
RETURNING updated_at, data #> '{automatedFollowUp,freeEntry,templateRules}' AS active_rules;
```

The `videoCodecVerified: true` config flag is only a hint. The server still checks the exact clinic-owned file with ffprobe before sending. If verification fails, the chatbot uses an approved text fallback in the customer's original language.
