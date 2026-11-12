# Neutro Sense secondary WhatsApp: six-day follow-up redesign

**Status:** Proposed; no marketing template submissions or customer sends have been authorized from this change. Do not enable a new marketing sequence until templates are approved and an independent pre-send/consent recheck is tested.

## Objective

Increase eligible follow-up coverage for verified Meta ad leads and Meta error 131060 enquiries without treating the ad click, an unreadable message, or a treatment inference as permission to send marketing after 24 hours.

## Customer flow

1. **0h:** Standard AI reply, or a fixed Meta 131060 recovery menu. No fabricated treatment.
2. **2h and 6h:** Existing customer-service reminders, only in a live WhatsApp 24-hour window, respecting consent/opt-out/staff takeover/bookings.
3. **20h:** Existing final service reminder, with an *optional* written invitation for genuine fresh ad enquiries or verified 131060 recoveries whose lead has no marketing permission. It explicitly describes up to six days of TCM information and related offers. Do not send another extra message merely to ask consent.
4. **Consent:** The customer must reply with the complete affirmative sentence in Chinese, English or Malay after a delivered, sender-bound invitation. The verified inbound is stored as a new generic marketing consent event tied to the current contact/lead/provider WAMID. Pre-filled ads, generic 'yes', and silent contacts do not qualify.
5. **48h, 66h, Day4 and Day6:** After additional reviewed marketing scheduler support, offer at most one approved, static MARKETING template per stage, only if the exact generic consent remains active and the customer's recent verified ad/131060 session is still eligible. Use the original verified event's age, no backfills, final sender/consent/template/billing checks, no duplicate or ambiguous sends.
6. **Unconsented/silent customers:** No paid marketing templates after the WhatsApp service window. Keep them in the staff Inbox for manual assessment without any automatic message.

## Pending approval: generic static marketing templates

Each stage is a MARKETING template with a completely static body, no variables, buttons or media. Per the operator's 12 Nov edit, the marketing bodies contain no standalone unsubscribe sentence; normal opt-out handling remains available. The language variants must be approved on the **secondary number's own account** before scheduling. No template is a Utility message.

| Stage | Template | Chinese (zh_CN) | English (en_US) | Malay (ms) |
|---|---|---|---|---|
| 48h | `ns_general_48h_optin_v1` | 您好～谢谢您关注 Neutro Sense TCM 😊 如果想了解我们的中医护理或首次评估，欢迎告诉我们您最关心的情况，我们可以为您说明。 | Hello 😊 Thanks for your interest in Neutro Sense TCM. If you have questions about our TCM care or first assessment, reply whenever convenient. | Hai 😊 Terima kasih kerana berminat dengan Neutro Sense TCM. Kalau ada soalan tentang penjagaan TCM atau penilaian pertama, boleh balas mesej ini. |
| 66h | `ns_general_66h_optin_v1` | 您好 😊 想轻轻跟进一下。如果您对中医护理、评估流程或到店安排有疑问，随时回复我们就好，不需要现在作决定。 | Hello 😊 Just checking in. If you'd like to ask about TCM care, assessment or visiting us, reply anytime. No need to decide now. | Hai 😊 Sekadar susulan ringan. Kalau nak tahu tentang penjagaan TCM, penilaian atau lawatan, balas bila-bila masa. Tak perlu buat keputusan sekarang. |
| Day4 | `ns_general_day4_optin_v1` | 您好～关于 Neutro Sense TCM 的一对一评估，如果您还想多了解护理如何安排，我们可以先回答您的问题，再由中医师评估是否适合。 | Hello 😊 Our individual assessment starts by understanding your concerns. If you'd like to know how it works, we can explain and the TCM practitioner can assess suitability. | Hai 😊 Semasa penilaian individu, kami akan fahami keperluan anda dahulu. Kalau nak tahu prosesnya, boleh tanya dan pengamal TCM boleh menilai kesesuaian rawatan. |
| Day6 | `ns_general_day6_optin_v1` | 您好 😊 这是这次的最后一次跟进。如果将来想了解我们的中医护理或预约评估，随时欢迎回复。谢谢您，祝您有美好的一天！ | Hello 😊 This is our last follow-up for now. If you ever want to learn about TCM care or arrange an assessment, you're welcome to reply. Wishing you a lovely day! | Hai 😊 Ini susulan terakhir kami buat masa ini. Jika nak tahu tentang penjagaan TCM atau aturkan penilaian, boleh balas bila-bila masa. Semoga hari anda baik! |

## Required go-live checks

- Template approval in zh_CN/en_US/ms on the *secondary* account.
- An independent feature switch and operator approval of paid marketing volume.
- A PostgreSQL test covering signed consent, ad/referral source, delivered recovery menu, all four slots, opt-outs, booking, staff takeover, language, billing and template signature.
- Duplicate-suppression across generic and treatment-specific attempts for the same contact/session.
- A reviewed, quiet-hours-aware scheduler with a durable one-shot send ledger and conservative unknown state.
- No retroactive customer messaging or promotional blasts.
