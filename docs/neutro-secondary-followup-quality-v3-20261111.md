# Neutro secondary follow-ups: 48h/66h copy v3 and quality review

Prepared 11 November 2026. **Draft templates only; not submitted or approved by this PR.** Do not replace live v2 template rules until Meta independently approves each selected language, the operator explicitly approves potential MARKETING charges, and staff verify the saved signatures. No customer messages are sent by this PR.

## 48h: answer a practical first-visit FAQ, instead of repeating price/process question

Template: `ns_48h_first_visit_faq_v3` (MARKETING, BODY only, no placeholders, no buttons or media).

**zh_CN**

小提醒：第一次来咨询护理，可以先了解大概所需时间、护理过程和注意事项 😊

每项护理的安排可能不同。如果你想知道之前咨询的项目一般需要多久，回复我，我帮你说明。

**en_US**

A quick tip before your first visit 😊

The time needed and preparation can vary by treatment. If you'd like to know roughly how long the care you asked about usually takes, reply here and I'll explain.

**ms**

Sedikit panduan sebelum lawatan pertama 😊

Tempoh dan persediaan boleh berbeza mengikut rawatan. Jika nak tahu anggaran masa untuk rawatan yang anda tanya, balas mesej ini dan saya bantu jelaskan.

## 66h: an assessment offer, only after customer re-engagement

Template: `ns_66h_engaged_assessment_v3` (MARKETING, BODY only, no placeholders, no buttons or media).

**zh_CN**

如果你还在考虑之前咨询的护理、也想安排到店评估，我可以帮你确认合适的时段 😊

有任何疑问也可以直接回复，不需要马上决定。

**en_US**

If you're considering coming in for the treatment you asked about, I can help check an assessment time 😊

If you still have questions, feel free to reply. There's no need to decide right away.

**ms**

Jika anda sedang pertimbangkan untuk datang bagi rawatan yang pernah ditanya, saya boleh bantu semak masa penilaian 😊

Jika masih ada soalan, boleh terus balas. Tak perlu buat keputusan sekarang.

## Changed sending policy

- 66h is only eligible if the customer sent another verified, sender-owned message after the first normal AI reply in the current conversation. An imported history message cannot trigger it.
- For someone completely silent since that AI reply, limit accepted follow-ups to five total across the sender's 2h/6h/20h service messages plus 48h/66h/Day4/Day6 marketing messages, within the currently qualified 167h session. Genuine later engagement can permit subsequent eligible steps.
- Counts and engagement checks are applied in discovery, immediate pre-send rechecks and read-only due-time scheduling. The cap does not bypass existing consent, language, booking, staff handoff, opt-out, account billing, uncertain-send or one-shot controls.
- No backfill or replay. Day 4/Day 6 retain their own activation cutoff and separate Meta approvals.
- The 20h processing errors reviewed from 4–8 Nov had no saved outbound message. New pre-save failures will be marked `blocked`, not delivery-`unknown`; after-save/provider uncertainty stays `unknown`. Both remain one-shot; never replay automatically.

## Performance and booking attribution

The existing **Tools → Results** report will also include secondary accepted follow-up messages, labelled by their actual hour slot. It uses the same 72h reply and seven-day pipeline-stage windows as the primary report. These are observed associations, not proof of booking causation. Staff must still record confirmed appointments in Pipeline/CRM; otherwise the booking count will remain zero.

## Rollout

1. Obtain explicit confirmation for six template submissions; submit Chinese, English and Malay v3 variants on **Neutro secondary WhatsApp only** and await independent Meta approval.
2. Do not overwrite or delete v2. Existing rules stay bound to their currently approved signatures while v3 is pending.
3. After verified approval, update 48h and 66h sender rules atomically with v3 variants and three-language signatures, recording fresh operator MARKETING charge acknowledgement. Do not modify Day 4/Day 6 templates.
4. Inspect 20h blocked vs unknown outcomes and monitor replies and appointments in Results for at least seven days. Do not interpret absent CRM bookings as absence of bookings.
5. Add approved 2h 3D/9D and pulse-wave 2h/6h media only when clinic-specific verified video assets exist. Keep text-only where missing. Never substitute another treatment video.
