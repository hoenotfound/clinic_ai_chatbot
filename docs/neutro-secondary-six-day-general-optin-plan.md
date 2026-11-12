# Neutro Sense secondary WhatsApp: six-day follow-up redesign

**Status:** Implementation prepared under PR #596. All twelve secondary-account MARKETING templates are approved. A separately approved billing and activation switch remains required; no customer sends or retrospective backfills are part of the implementation.

## Objective

Increase eligible follow-up coverage for verified Meta ad leads and Meta error 131060 enquiries without treating the ad click, an unreadable message, or a treatment inference as permission to send marketing after 24 hours.

## Customer flow

1. **0h:** Standard AI reply, or a fixed Meta 131060 recovery menu. No fabricated treatment.
2. **2h and 6h:** Existing customer-service reminders, only in a live WhatsApp 24-hour window, respecting consent/opt-out/staff takeover/bookings.
3. **6h and 20h:** Offer the *optional* written marketing invitation to verified fresh ad enquiries or 131060 recoveries whose lead has no marketing consent. At 6h include it in the existing reminder text or approved video caption; offer a one-tap opt-in button with text reminders. At 20h offer it again if still unconsented. Do not send extra standalone messages merely to request consent.
4. **Consent:** The customer must reply with the complete affirmative sentence in Chinese, English or Malay, or tap the genuine sender-bound opt-in button on an interactive text reminder, after a delivered invitation. The verified inbound is stored as a new generic marketing consent event tied to the current contact/lead/provider WAMID. Pre-filled ads, generic 'yes', and silent contacts do not qualify.
5. **48h, 66h, Day4 and Day6:** The existing billable marketing sender now selects the pinned approved generic template only with separate, signed generic consent linked to the secondary contact and lead. Recheck consent, sender, status, signature, billing, staff ownership and due window before each provider call. A verified new customer message moves the next due time to 24h after that reply; each later stage waits at least 18h after the previous accepted marketing stage. The original verified enquiry remains the anchor and the 167-hour hard cutoff is unchanged, so a late reply may still leave too little time for all four stages. One-shot attempt ledger is shared with treatment-specific marketing to prevent duplicate slots. No backfills.
6. **Unconsented/silent customers:** No paid marketing templates after the WhatsApp service window. Keep them in the staff Inbox for manual assessment without any automatic message.

## Approved generic static marketing templates

Each stage is an **APPROVED MARKETING** template with a completely static body, no variables, buttons or media. Per the operator's 12 Nov edit, the marketing bodies contain no standalone unsubscribe sentence; normal opt-out handling remains available. The language variants belong to the **secondary number's own account**. No template is a Utility message.

| Stage | Template | Chinese (zh_CN) | English (en_US) | Malay (ms) |
|---|---|---|---|---|
| 48h | `ns_general_48h_optin_v1` | 您好～谢谢您关注 Neutro Sense TCM 😊 如果想了解我们的中医护理或首次评估，欢迎告诉我们您最关心的情况，我们可以为您说明。 | Hello 😊 Thanks for your interest in Neutro Sense TCM. If you have questions about our TCM care or first assessment, reply whenever convenient. | Hai 😊 Terima kasih kerana berminat dengan Neutro Sense TCM. Kalau ada soalan tentang penjagaan TCM atau penilaian pertama, boleh balas mesej ini. |
| 66h | `ns_general_66h_optin_v1` | 您好 😊 想轻轻跟进一下。如果您对中医护理、评估流程或到店安排有疑问，随时回复我们就好，不需要现在作决定。 | Hello 😊 Just checking in. If you'd like to ask about TCM care, assessment or visiting us, reply anytime. No need to decide now. | Hai 😊 Sekadar susulan ringan. Kalau nak tahu tentang penjagaan TCM, penilaian atau lawatan, balas bila-bila masa. Tak perlu buat keputusan sekarang. |
| Day4 | `ns_general_day4_optin_v1` | 您好～关于 Neutro Sense TCM 的一对一评估，如果您还想多了解护理如何安排，我们可以先回答您的问题，再由中医师评估是否适合。 | Hello 😊 Our individual assessment starts by understanding your concerns. If you'd like to know how it works, we can explain and the TCM practitioner can assess suitability. | Hai 😊 Semasa penilaian individu, kami akan fahami keperluan anda dahulu. Kalau nak tahu prosesnya, boleh tanya dan pengamal TCM boleh menilai kesesuaian rawatan. |
| Day6 | `ns_general_day6_optin_v1` | 您好 😊 这是这次的最后一次跟进。如果将来想了解我们的中医护理或预约评估，随时欢迎回复。谢谢您，祝您有美好的一天！ | Hello 😊 This is our last follow-up for now. If you ever want to learn about TCM care or arrange an assessment, you're welcome to reply. Wishing you a lovely day! | Hai 😊 Ini susulan terakhir kami buat masa ini. Jika nak tahu tentang penjagaan TCM atau aturkan penilaian, boleh balas bila-bila masa. Semoga hari anda baik! |

## Required go-live checks

- Completed: twelve static templates approved in zh_CN/en_US/ms on the secondary account; pinned IDs and body signature are checked before every send.
- Independent feature switch and operator approval of paid marketing volume: `WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED`, `WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED`, and `WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT`. All must be valid for any generic send.
- PostgreSQL tests compile generic candidates, pre-send rechecks, due-time hint and signed consent policy; sender tests exercise all 12 pinned variants, delivery ambiguity, revoked authorization and body mismatch.
- Duplicate-suppression across generic and treatment-specific attempts for the same contact/session.
- Uses the existing reviewed, quiet-hours-aware marketing scheduler, durable one-shot send ledger and conservative unknown state.
- Cutoff at activation timestamp excludes older customer enquiries and consent. No retroactive customer messaging or promotional blasts.

## Button and delivery safeguards

- Interactive consent is offered only as an existing 6h or 20h text reminder, not an extra outbound message. The button ID includes its saved outbound message ID and the customer language.
- A button tap is recorded only from Meta's signed `interactive.button_reply` payload when the exact prompt is verified as sent/delivered/read on the active secondary sender, bound contact, and current open lead.
- Typing a button label, sending `Yes`, replying to an unrelated prompt, reusing an imported chat, or tapping after an opt-out does not grant consent.
- The 6h video remains a single approved media message with a bounded caption containing the full opt-in sentence, without a separate button or extra send.
- A paid marketing stage waits until 24h after the latest verified customer reply and at least 18h after the previous accepted stage. Only the scheduled stage moves; the campaign never backfills beyond 167h.
- Meta can charge for template deliveries. Production activation and billing approval are separate operator-controlled settings and must not be inferred from template approval.

## Read-only coverage checks

Run the following read-only query on Neutro's own Neon database to measure
actual opt-in coverage and delivered optional invitations for the preceding
seven days. Results include no customer identifiers and require no background
polling. Recheck after enabling the campaign from a **fresh activation UTC
timestamp**. A delivered invitation is not itself marketing consent.

```sql
WITH secondary AS (
  SELECT id FROM whatsapp_sender_accounts
  WHERE sender_key='neutro_secondary'
), invitation AS (
  SELECT DISTINCT m.id, m.contact_id
  FROM messages m
  JOIN whatsapp_sender_message_context ctx ON ctx.message_id=m.id
  JOIN whatsapp_sender_conversations sc ON sc.id=ctx.conversation_id
  JOIN secondary sa ON sa.id=sc.sender_id
  WHERE m.role='assistant' AND m.is_automated_follow_up=TRUE
    AND m.delivery_status IN ('sent','delivered','read')
    AND m.created_at >= NOW()-INTERVAL '7 days'
    AND (
      m.content LIKE '%我同意通过 WhatsApp 接收 Neutro Sense%'
      OR m.content LIKE '%I agree to receive WhatsApp follow-ups%'
      OR m.content LIKE '%Saya setuju menerima susulan WhatsApp%'
    )
), opted AS (
  SELECT DISTINCT e.contact_id
  FROM whatsapp_marketing_consent_events e
  JOIN contacts c ON c.id=e.contact_id
  JOIN secondary sa ON sa.id=c.whatsapp_sender_id
  WHERE e.consent_scope='general_clinic_followups_and_related_offers'
    AND e.consented_at>=NOW()-INTERVAL '7 days'
)
SELECT (SELECT COUNT(*) FROM invitation) AS delivered_invitations,
       (SELECT COUNT(DISTINCT contact_id) FROM invitation)
         AS invited_contacts,
       (SELECT COUNT(*) FROM opted) AS opted_in_contacts;
```

Existing global and promotional STOP handling remains active even though
outbound invitation and marketing template text no longer contains the
standalone unsubscribe sentence.

## Meta template submission record (12 November 2026)

Submitted for review only. These templates are not connected to an enabled Day 2–6 sender. Review states can change after this snapshot.

| Stage | Language | Template ID | Status at verification |
|---|---|---|---|
| 48h | zh_CN | `1905472777488799` | APPROVED |
| 48h | en_US | `1678631883658802` | APPROVED |
| 48h | ms | `1050283584461707` | APPROVED |
| 66h | zh_CN | `1428658446081895` | APPROVED |
| 66h | en_US | `934353596290800` | APPROVED |
| 66h | ms | `1014407884244968` | APPROVED |
| day4 | zh_CN | `1437971061777600` | PENDING |
| day4 | en_US | `2231905270698330` | APPROVED |
| day4 | ms | `29319248334380148` | APPROVED |
| day6 | zh_CN | `2101944657185777` | PENDING |
| day6 | en_US | `29784962131111986` | PENDING |
| day6 | ms | `1675055354240049` | PENDING |

## Post-merge verification

The review branch incorporates later Inbox, Messenger and secondary-number
ownership improvements from `main`. Verify the combined commit with a fresh
full CI run before merging, rather than relying on earlier successful tests.
The new paid campaign must remain off until the combined deployment has passed
its startup checks. Activate with a new timestamp so no historical consent or
old ad conversation enters the new campaign.

Combined release gate (12 November): PR #600 was merged into main before PR #599. Run the full checks again on PR #599 against the updated main before deploying or activating paid six-day templates.
