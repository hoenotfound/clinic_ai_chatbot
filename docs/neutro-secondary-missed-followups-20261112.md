# Neutro secondary follow-up investigation and corrective patch

Reviewed 12 November 2026. Contact and message IDs are internal identifiers for reproducible tests, not targets for message blasts.

## Symptom A: quiet-hour-delayed 6h messages suppress 20h

For the verified 9D treatment enquiry, inbound was 10 Nov 2026 at 20:36 MYT. The 6h video could not be sent during quiet hours and was accepted 11 Nov at 07:00. Previously, the scheduler added another 14 hours to the actual 6h send time and moved the 20h invitation to 21:00, after the initial customer message's 24-hour window at 20:36.

The patch retains the original 20h due time, waiting only 15 minutes after the accepted preceding service reminder if necessary. It explicitly refuses a 20h candidate whose due time would fall outside the original inbound's 24-hour limit. The existing sender, quiet-hour, appointment, opt-out, staff intervention, one-shot and provider-billing guards remain. Do not backfill skipped 20h sends.

## Symptom B: 9D choice stored, 3D interest inferred from ad

The same sender's CRM lead had `3D 小颜术` because the Meta creative mentioned 3D, but the verified inbound chose `9D 逆龄抗衰`. The sender-scoped treatment state recorded 9D and a separate explicit 9D marketing consent event existed. The marketing candidate query used the stale CRM value and rejected the contact.

The patch:
- Chooses an existing provider-verified, sender-owned customer treatment state ahead of a stale CRM/ad label for marketing eligibility.
- **Still requires independently recorded MARKETING consent matching that chosen treatment exactly**, plus the existing safe sender, temporal, opt-out, billing and staff gates. A 3D consent cannot authorize 9D.
- On **new** verified treatment selections only, reconciles the latest **Automation-created, Meta-attributed, not staff-owned, open** CRM lead to the saved choice. It does **not** modify marketing consent, ad attribution, staff-owned or closed leads. An unavailable CRM sync does not authorize a send.
- Does not mass-update historical leads. Existing verified choices can be considered by the revised marketing selector but previously missed or blocked attempts remain one-shot and must not be resent.

## Symptom B2: re-engaged customer is stranded after the 2h cooldown

Each verified customer reply correctly starts a new 24-hour service-window sequence, but the 2h reminder is protected against duplicate videos for seven days. The old worker required an accepted 2h attempt **on the newest inbound anchor** before it would allow 6h, leaving follow-ups stuck after the customer replied to the first 2h video.

The amended worker may use a recently accepted previous 2h or 6h step as a **prerequisite only**, without sending that stage again. This proof must belong to the same sender-bound conversation, have been accepted within 24h before the new inbound, and have no intervening staff message, uncertain/blocked send, imported message or newer verified treatment decision. The latest inbound and its normal AI reply still define the new due time. All existing 7-day media cooldowns, sender-specific one-shot claims, reply windows, booking and opt-out holds remain.

A new treatment selection may continue the earlier sequence only when the previously accepted outbound message contains the exact same saved treatment name. New secondary 2h/6h messages now store that treatment snapshot. Older messages with no snapshot remain blocked if the customer makes another explicit selection, so an earlier 3D testimonial can never unlock a 9D sequence.

## Symptom B3: AI lead-scoring summaries can overwrite the saved customer choice

After the verified treatment choice is reconciled to an automation-owned lead, the separate AI scoring process can still update `leads.treatment_interest` from its model summary. Both scoring update branches now preserve the existing CRM treatment label when an active, sender-bound verified secondary customer selection exists. Scoring can continue to update temperature and its audit metadata. No consent or staff-controlled CRM field is changed.

## Symptom B4: late re-engagement makes the 48h/66h reminders impossible

The ordinary 48h/66h selector previously demanded at least 24 hours since
the **latest** customer message but required sending no more than 8 hours
after a **fixed** reminder time measured from the first normal AI reply.
For example, a customer who re-engaged at hour 60 could not receive the
66-hour template: its fixed window ended at 74h while the customer silence
check would not clear until hour 84.

The ordinary (not Day4/Day6) marketing scheduler now uses the **later** of:
- the nominal 48h/66h session time;
- 24h after the latest verified customer message;
- for 66h only, 18h after an accepted 48h template in the same session.

It still expires 48h at the 66h stage and 66h at the Day4 stage, and never
continues beyond the original 167-hour session limit. It does not produce
two marketing reminders within the same day to make up for late replies.
A newer due slot suppresses an older one, and accepted/blocked/unknown/claimed
slots from a different customer-message anchor in the same session still
block a duplicate. Every actual send still rechecks the latest opt-in,
treatment-specific consent, language, booking, handoff, Meta template
approval, billing and one-shot attempt.

For all-contacts **non-ad** conversations, the ordinary first-reply anchor
is deliberately reset to the latest customer/AI exchange. Since this
makes the standard `engaged.created_at > first_reply.at` condition
impossible by construction, the conditional 66h rule now also accepts a
**separately verified prior customer message followed by a normal AI reply**
in the same sender-owned conversation in the preceding seven days.
This proof does not authorize consent, remove booking or handoff holds,
or apply to imported Business App history. Ad-originated Day4/Day6 keep
their original fixed, independently signed seven-day session clock.

**Example:** after the initial AI response at 0h, a new customer message
at 60h results in a potential 66h invite at 84h, provided the customer
remains silent for a full day and has no new staff/booking/consent holds.
A late 48h message is skipped when the 66h phase is already due.
No previously recorded unknown send is automatically replayed.

## Symptom C: unreadable Meta error 131060

An unsupported secondary incoming message (internal contact 9008) contained Meta code 131060, with **no text, referral, or advertising attribution** in the signed inbox job. The existing system correctly sent three selectable treatment buttons, and no later customer selection was recorded.

**No software change can recover text Meta did not deliver.** Preserve the existing recover-first-menu path and do not infer treatment from the screenshot, an ad campaign name, or a different contact. A new real customer reply or button tap can establish treatment; marketing still requires explicit consent and Meta ad proof if relevant to that sending path. Staff can follow up manually as appropriate, but no automated marketing message is authorized from an unreadable placeholder alone.

## Rollout checks

- CI must pass backend, actual migrated PostgreSQL integration, and portal/browser suites. Review any SQL query performance regressions before merge.
- Do not alter production database, Render environment, existing consent records, follow-up rule activation timestamps or template signatures as part of this PR.
- After separately authorized merge/deploy, verify the 20h candidate timing around 07:00 MYT; confirm treatment-specific consent matching and one-shot attempt records; monitor new follow-up delivery and error rates.
- Do not replay historical missed 20h, 48h, 66h, Day4 or Day6 messages.
