# Neutro Sense secondary WhatsApp: seven-day reminder copy v2
Prepared 11 Nov 2026. **All eight new variants are approved by Meta but are not enabled by this PR.**

## Existing 48-hour template: add Malay variant only
Name: `ns_48h_choice_v2`, language `ms`, category `MARKETING`.
Other approved languages remain unchanged.

Hai~ Ada apa-apa lagi tentang rawatan yang anda tanya sebelum ini yang masih kurang jelas? 😊
Anda nak tahu harga dahulu atau proses rawatan? Balas salah satu, saya bantu terangkan ya.

## Existing 66-hour template: add Malay variant only
Name: `ns_66h_assessment_v2`, language `ms`, category `MARKETING`.
Other approved languages remain unchanged.

Hai~ Kalau anda nak tahu sama ada rawatan ini sesuai untuk anda, saya boleh bantu semak jadual penilaian bersama pengamal TCM kami 😊
Anda lebih senang datang ke PJ pada hari bekerja atau hujung minggu? Saya bantu semak masa yang sesuai.

## Day 4 (96 hours): explain the assessment, do not repeat a generic check-in
Template name: `ns_day4_assessment_guide_v2`, category `MARKETING`.

### zh_CN
Hi～想补充一点你之前咨询的护理资讯 😊

初次来访时，我们会先了解你在意的部位和想改善的情况，再由中医师评估适合的护理方向。你想先了解评估步骤，还是护理过程呢？

### en_US
Hi~ Here's something useful about the treatment you asked about 😊

At your first visit, we start by understanding your main concerns before our TCM practitioner assesses a suitable care approach. Would you like to know more about the assessment or the treatment process?

### ms
Hai~ Ini sedikit maklumat tambahan tentang rawatan yang anda tanya 😊

Semasa kunjungan pertama, kami akan fahami dahulu perkara yang anda ingin perbaiki sebelum pengamal TCM menilai pendekatan rawatan yang sesuai. Nak tahu lebih lanjut tentang penilaian atau proses rawatan?

## Day 6 (144 hours): final low-pressure invitation, no fake scarcity
Template name: `ns_day6_final_invite_v2`, category `MARKETING`.

### zh_CN
Hi～如果你之后还想继续了解之前咨询的护理，随时回复我们就好 😊

想先安排一对一评估，或了解近期的体验安排，我可以帮你确认。这边先不打扰你啦，祝你今天顺心！

### en_US
Hi~ If you'd like to revisit the treatment you enquired about, you're welcome to reply anytime 😊

I can help check an individual assessment or current trial arrangements when you're ready. I'll leave it here for now. Have a lovely day!

### ms
Hai~ Kalau anda masih nak tahu tentang rawatan yang pernah ditanya, boleh balas bila-bila masa 😊

Saya boleh bantu semak sesi penilaian individu atau aturan sesi percubaan terkini apabila anda bersedia. Saya tak ganggu lagi buat masa ini. Semoga hari anda baik!

## Approval and rollout
- All eight language templates were submitted and verified APPROVED on the Neutro secondary WhatsApp account: six Day 4/6 v2 variants and two 48/66 Malay variants. Existing approved templates were preserved.
- Templates are MARKETING text without variables, media or CTA buttons. Existing 48/66 Chinese and English copy is unchanged.
- Every selected language must be independently APPROVED before saving a sender-specific enabled rule. Do not silently substitute another language or an earlier approved template.
- Preserve explicit sender- and treatment-specific marketing consent, staff/appointment/opt-out holds, 00:00–07:00 MYT quiet hours, verified ad origin, 167-hour deadline and one-shot ambiguous-send guards.
- The unknown billing reservation from 4 Nov has no matched provider receipt. It continues to block its affected contact only. Sender-wide billing alarms still block all sends; never clear uncertain records automatically.
- Keep `WHATSAPP_SECONDARY_EXTENDED_DAY4_DAY6_ENABLED` disabled until the separately approved language rules, operator billing acknowledgement, and sender-level safeguards have been checked. Do not backfill older ad conversations.
- A verified free-entry receipt is not proof future MARKETING templates are all free.
