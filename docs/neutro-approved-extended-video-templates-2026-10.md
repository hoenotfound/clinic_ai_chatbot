# Neutro Sense: configuring approved WhatsApp video templates

This is a **Tools configuration guide**, not a database migration. PR #348 changes no Neutro follow-up schedule or clinic configuration. **Do not edit `clinic_config` in Neon manually.**

## Why there is no automatic activation

The first 2-hour/6-hour follow-ups already send Neutro's existing videos to many leads. Setting those same videos at 48h/66h must not resend them. Neutro's current production rules remain unchanged:

| Slot | Existing default text template |
|---|---|
| 48h | `ns_enquiry_reengagement` |
| 66h | `ns_fu2_general_checkin` |

Only configure treatment-specific video overrides if there is a customer journey where the early video was **not** sent. If the earlier video was sent (even under a different filename with the same R2 ETag and size), the worker uses the text template configured for that slot.

## Configure in DA CHATBOT Tools after merging/deploying

1. Open **Tools → Follow-ups → Extended WhatsApp Templates** in the Neutro client instance.
2. Refresh the Meta-approved template catalog. The following approved **Marketing / VIDEO** templates are already available:
   - `ns_pelvis_followup_video` (pelvis explanation, zh_CN only)
   - `ns_fu3_pelvis_feedback` (pelvis testimonial, zh_CN/en)
   - `ns_fu3_face_feedback` (3D / 9D / 3D+9D facial experience, zh_CN/en)
3. Keep the 48h and 66h wildcard **text** rules. Add optional **treatment-specific** overrides in the same slots:

| Slot | Treatment | Approved template | Choose existing clinic video |
|---|---|---|---|
| 48h | 骨盆调理 | `ns_pelvis_followup_video` | FU1 pelvis explanation |
| 48h | 3D 小颜术 | `ns_fu3_face_feedback` | FU2 3D facial experience |
| 48h | 9D 逆龄抗衰 | `ns_fu3_face_feedback` | FU2 9D facial experience |
| 48h | 3D + 9D 组合 | `ns_fu3_face_feedback` | FU2 3D+9D facial experience |
| 66h | 骨盆调理 | `ns_fu3_pelvis_feedback` | FU2 pelvis customer testimonial |

4. For every video rule, select **Choose saved video** and let the server verify H.264/AAC and the clinic-owned R2 path. Do not upload another copy solely because the Meta template's approval example already contains it.
5. Preview the template and attachment, then **Save through Tools**. This performs config validation, updates the live server configuration, wakes the worker, and starts a fresh activation for future eligible enquiries. Prior claims are never replayed.
6. Check an eligible, consented CTWA enquiry and confirm the actual template name, exact video/media key (or same-slot text fallback), language, delivery callback and Meta zero-cost evidence. Never assume an approved template guarantees a free send.

## Operational safeguards

- Already-sent video: same-key and same-content (R2 ETag/size) checks select the **same-slot approved text** fallback. If the fallback was already used, the slot is skipped, not substituted with unrelated wording.
- Media missing, failed codec verification or unmatched treatment: use the same-slot approved text fallback, or skip if no safe fallback is configured.
- English Meta video template variant is `en`, while the customer's language detection can return `en_US`; the worker matches these. There is no approved Malay video variant in the reviewed catalog, so Malay enquiries stay on the approved Malay text template.
- Existing consent, opt-out, human takeover, pause, 24-hour and strict free-only billing guards remain mandatory.
- The facial variants currently reference files with identical ETag/size, so they're the same footage for deduplication.

## Rollback

Use **Tools** to remove treatment-specific video override rules while preserving the two wildcard text rules, and Save. Do not force sends or alter historical attempt records. The default 48h/66h text schedule continues working.

**CI:** run backend and portal tests before merging; confirm an actual eligible send in a nonproduction account or controlled fresh test conversation before relying on production operation.
