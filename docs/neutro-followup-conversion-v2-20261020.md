# Neutro Sense | conversion-first WhatsApp follow-up copy v2 (review proposal)

**Status: COPY REVIEW ONLY — NO CONFIG OR META TEMPLATE CHANGES.** Prepared 20 October 2026. Do not enable, edit live templates, send messages, or merge into a rollout as-is.

## Why update

10-day Neon sample reviewed on 20 October:
- AI-personalized FU1: 30/79 replies within 24h (some may be replies to later messages as well).
- AI-personalized FU2: 12/41.
- AI-personalized FU3: 6/36.
- Approved 48h template: 1/12 replies, only `stop promotions`.
- Approved 66h template: 1/11 replies, same customer's `stop promotions`.
- **No positive replies observed to either generic template**; tiny sample, not an experiment.
- FU1 explanation media: 21/79 AI-personalized messages; FU2 testimonial media: 36/41.
- Contact #613 asked about 骨盆 fees, then replied "Weekday.. 想知道配套及单次价钱😁" to a booking invitation; bot asked which treatment price was about. Price-context handling is a separate blocking conversion issue.
- Funnel's appointment statuses are sparsely populated; don't claim that replies caused bookings.

## Conversation design principles

1. Continue the conversation, don't "reintroduce" Neutro Sense at every step. Malaysian Chinese; short, warm, no sales blast, no repeated "Hi～再来关心一下".
2. One message has one goal and one simple question. Reference the exact most recent customer concern and previous answer where AI is available. Prefer realistic answer choices: 价钱/过程 or 平日/周末.
3. FU1 answers a barrier and optionally explains the actual treatment process; FU2 provides one **matching** experience video without guaranteeing results; FU3 offers evaluation and a scheduling question, without implying a confirmed appointment.
4. Never re-ask service/price when it was established by ad + messages. If the customer asked price, provide the current verified promotion/first trial price, package terms and duration clearly first, then ask a booking question. If the customer says weekday, ask a day/time, not weekday/weekend again.
5. After booking/visit, opt-out, explicit "我再安排"/"let me think", staff takeover, human/clinical review, or inappropriate conditions, stop or skip follow-ups as configured. Never manufacture urgency or available appointment slots.
6. 3D/9D's paid First Trial must not be called free. Only the approved complimentary pelvic/body introductory assessment + experience can be described as complimentary, in applicable context.
7. No clinical promises ("无副作用", "100% success", skull bone sutures shrinking), unsupported efficacy claims, or invented testimonials.
8. Don't insert "Stop promotions" in customer-facing template copy, per user request, while retaining working opt-out detection, marketing consent checks and relevant Meta compliance requirements.
9. 00:00–07:00 quiet hours, template approvals, unique slot claims, double-sends, Media/receipt audits and expired windows remain unchanged. Strict RM0 remains OFF.
10. Keep 96h/144h inactive until separate rollout; the 48h/66h rewrite should be evaluated before adding more touches.

## Stage 1: AI messages in the 24-hour window — draft behaviors

### FU1 around 2h: help with the actual concern
**Instruction v2:** "Use the original ad/service and last customer request as the main context; do not repeat discovery if it is already known. If an exact matching explanation video is available and not previously sent, send one and introduce it in one short line. If absent, never mention a video. If customer's last unresolved question is price, location, sessions, pain, recovery or how to book, answer that verified question instead of diverting to another discovery question. Ask at most ONE low-effort question about an unresolved decision, such as '想先知道价钱还是过程？'. Do not imply a confirmed appointment, free paid trial, pain-free outcome or guaranteed effectiveness. SKIP a cold, opted-out, deferred, staff-handled or booked lead."

Example, for a customer who has asked about pelvic treatment but NOT its price (and with video configured):
> 你之前提到想了解骨盆调理，我发这段护理过程给你参考一下 😊 你比较想先看配套价钱，还是想知道体验当天会怎样进行？

If price already requested, answer the verified price instead. Do NOT send the above question.

### FU2 around 6h: evidence without claims
**Instruction v2:** "If the latest identified treatment has an authentic, unsent and approved customer-experience video, share ONE relevant video with a 1–2-sentence natural caption. Don't call a process video a testimonial or claim outcomes not supported by the video. Acknowledge that outcomes differ and make it easy to ask a specific question. If no qualifying video exists, send ONE useful concise clarification about the customer's concern rather than a generic testimonial. No repeated category questions or 'many customers say ...' without reliable support. SKIP when already replied, booked, deferred, opted out, clinically sensitive or staff-handled."

Example, only when sending an actual testimonial video:
> 给你看看一位顾客的体验分享 😊 每个人的情况不一样，可以当作参考～ 你还有想确认护理感觉或过程的地方吗？

### FU3 around 20h: next step without sounding like a goodbye
**Instruction v2:** "If interest remains and the customer has no unanswered question, offer one appropriate evaluation or trial discussion and ask ONE practical scheduling question. For pelvic/body, correctly distinguish free introductory 1-on-1 body/posture assessment + introductory experience from a separate paid full treatment. For face, offer an assessment/trial discussion WITHOUT saying its paid trial is free. Reflect the specific service or concern; avoid '先不打扰你啦', '祝你顺心', '随时再找我' as the only CTA. Ask weekday/weekend only if not already answered; otherwise ask date/time. Never assert time is available without a booking check."

Pelvic example:
> Hi～你之前提到想了解骨盆和体态，如果想先让中医师了解情况，我们可以安排免费1对1体态评估＋入门体验 😊 你平日还是周末比较方便来 PJ？我帮你确认时间～

3D/9D example:
> Hi～如果你还想了解脸型轮廓／紧致护理，我们可以先帮你安排中医师了解脸部情况，再看看适合哪种方式 😊 你平日还是周末比较方便来 PJ？

## Stage 2: NEW approved-template submissions required for any replacement

Do not edit current 48h `ns_enquiry_reengagement` or 66h `ns_fu2_general_checkin` in place: they are approved and live. Create separately named `ns_48h_choice_v2` and `ns_66h_assessment_v2`, each with zh_CN/en_US/ms, MARKETING, no media and no body variables, then wait for approval and explicitly switch the two Neon template rules. The old templates continue working until the switch.

### 48h `ns_48h_choice_v2`: easy information choice

zh_CN:
> Hi～你之前想了解的护理，还有什么没弄清楚的吗？😊
>
> 你比较想先看价钱，还是了解整个护理过程？回我其中一个就好，我帮你整理～

en_US:
> Hi~ Just checking back on the treatment you enquired about 😊
>
> Would you prefer to know the price or how the treatment works? Reply with whichever you'd like and I'll explain.

ms:
> Hai~ Nak tanya sikit tentang rawatan yang anda pernah tanya 😊
>
> Nak tahu harga dulu atau macam mana sesi rawatan dibuat? Balas yang mana satu pun boleh, saya terangkan ya.

### 66h `ns_66h_assessment_v2`: concrete booking bridge

zh_CN:
> Hi～如果你想先了解这个护理适不适合自己，我可以帮你看看中医师的评估安排 😊
>
> 你平日还是周末比较方便来 PJ？我帮你确认时段～

en_US:
> Hi~ If you'd like to discuss whether the treatment suits you, I can help check an assessment time with our TCM practitioner 😊
>
> Is a weekday or weekend easier for you to come to PJ?

ms:
> Hai~ Kalau nak tahu sama ada rawatan ini sesuai untuk anda, saya boleh bantu semak masa penilaian dengan tabib TCM 😊
>
> Anda lebih senang datang ke PJ hari bekerja atau hujung minggu?

## Stage 3: revised future Day 4 and Day 6 — NOT LIVE YET

Approved existing `ns_day4_checkin` and `ns_day6_invitation` must **not** be silently edited or replaced in the live config. Submit separate _v2 names if these rewrites are approved, and retain the original approved templates while waiting.

### 96h `ns_day4_assessment_explainer_v2`: reduce uncertainty

zh_CN:
> Hi～第一次尝试护理，想多了解清楚是很正常的 😊
>
> 中医师会先了解你的情况，再建议适合的方式，不需要马上决定做配套。
>
> 你想先知道评估当天大概会怎样进行吗？

en_US:
> Hi~ It's normal to have a few questions before trying a new treatment 😊
>
> Our TCM practitioner will first understand your concerns before recommending what's suitable. There's no need to decide on a package straight away.
>
> Would you like a quick overview of what happens during the assessment?

ms:
> Hai~ Biasalah kalau ada soalan sebelum cuba rawatan baru 😊
>
> Tabib TCM akan fahamkan keadaan anda dulu sebelum cadangkan rawatan yang sesuai. Tak perlu terus pilih pakej.
>
> Nak saya terangkan apa yang berlaku semasa sesi penilaian?

### 144h `ns_day6_timing_v2`: one last practical invitation

zh_CN:
> Hi～如果之后想安排之前咨询的护理，我可以帮你看看中医师的时间 😊
>
> 这星期你大概哪一天比较方便来 PJ？告诉我日期或时段，我帮你确认～

en_US:
> Hi~ If you'd still like to come in about the treatment you asked us about, I can help check a time with our TCM practitioner 😊
>
> Is there a day or time this week that suits you? I'll check what's available.

ms:
> Hai~ Kalau masih nak datang untuk rawatan yang anda tanya sebelum ini, saya boleh bantu semak masa dengan tabib TCM 😊
>
> Minggu ini hari atau waktu apa yang sesuai untuk anda? Saya boleh semak dulu.

## Booking and reply-funnel fixes: separate, higher-priority engineering task

- When the customer asks "多少钱", "price", "RM488 for one time", "single price", "package A/B", use ad attribution + most recently identified treatment. Answer known CURRENT validated price and terms; don't ask which treatment again.
- If single-session price is not configured, transparently say only the single price needs checking, but send verified package prices immediately and offer staff handoff to resolve the missing amount.
- If the customer asks address, show the one true PJ branch address and location info; then ask ONE scheduling question.
- If the customer replies "weekday", "weekend", or a date, progress to exact date / time. If no calendar availability source exists, say you'll confirm, not that an appointment is booked.
- Raise a Booking Ready summary / staff handoff once a customer indicates visit intent; stop marketing when booking is set.
- For "我考虑一下/我再安排", do not use a follow-up that presses for a booking.
- Never conflate consent-request automation with the three customer-facing AI follow-up steps.

## Recommended experiment and metrics
- First deploy **only** a small randomized, opted-in 48h/66h v2 copy cohort, after approved templates and safety tests. Keep 96h/144h off during initial evaluation.
- Track **unique contacts** who positively reply within 24h (exclude stop-promotions, another ad's prefilled message, duplicates and wrong-attribution replies); actual confirmed appointments; opt-outs; read/delivered; and Meta pricing billable state.
- Compare to the old template/control for at least 1–2 weeks or until adequate sample. The historical sample has no positive template replies but is small; don't promise conversion uplift.
- Manual opt-out handling stays active even though the visible opt-out footer is removed. Review any Meta-required opt-out facilities before submission.
- No new billable sends, tests, Meta submission, app configuration changes or Strict RM0 changes are authorized by this copy-only proposal.
