# Neutro Sense secondary WhatsApp: six-day follow-up redesign

**Status:** Implementation prepared under PR #596. All twelve secondary-account MARKETING templates are approved. A separately approved billing and activation switch remains required; no customer sends or retrospective backfills are part of the implementation.

## Objective

Increase eligible follow-up coverage for verified Meta ad leads and Meta error 131060 enquiries without treating the ad click, an unreadable message, or a treatment inference as permission to send marketing after 24 hours.

## Customer flow

1. **0h:** Standard AI reply, or a fixed Meta 131060 recovery menu. No fabricated treatment.
2. **2h and 6h:** Existing customer-service reminders, only in a live WhatsApp 24-hour window, respecting consent/opt-out/staff takeover/bookings.
3. **20h:** Existing final service reminder, with an *optional* written invitation for genuine fresh ad enquiries or verified 131060 recoveries whose lead has no marketing permission. It explicitly describes up to six days of TCM information and related offers. Do not send another extra message merely to ask consent.
4. **Consent:** The customer must reply with the complete affirmative sentence in Chinese, English or Malay after a delivered, sender-bound invitation. The verified inbound is stored as a new generic marketing consent event tied to the current contact/lead/provider WAMID. Pre-filled ads, generic 'yes', and silent contacts do not qualify.
5. **48h, 66h, Day4 and Day6:** The existing billable marketing sender now selects the pinned approved generic template only with separate, signed generic consent linked to the secondary contact and lead. Recheck consent, sender, status, signature, billing, staff ownership and due window before each provider call. One-shot attempt ledger is shared with treatment-specific marketing to prevent duplicate slots. No backfills.
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
