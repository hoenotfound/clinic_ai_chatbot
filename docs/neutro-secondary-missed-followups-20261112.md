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

## Symptom C: unreadable Meta error 131060

An unsupported secondary incoming message (internal contact 9008) contained Meta code 131060, with **no text, referral, or advertising attribution** in the signed inbox job. The existing system correctly sent three selectable treatment buttons, and no later customer selection was recorded.

**No software change can recover text Meta did not deliver.** Preserve the existing recover-first-menu path and do not infer treatment from the screenshot, an ad campaign name, or a different contact. A new real customer reply or button tap can establish treatment; marketing still requires explicit consent and Meta ad proof if relevant to that sending path. Staff can follow up manually as appropriate, but no automated marketing message is authorized from an unreadable placeholder alone.

## Rollout checks

- CI must pass backend, actual migrated PostgreSQL integration, and portal/browser suites. Review any SQL query performance regressions before merge.
- Do not alter production database, Render environment, existing consent records, follow-up rule activation timestamps or template signatures as part of this PR.
- After separately authorized merge/deploy, verify the 20h candidate timing around 07:00 MYT; confirm treatment-specific consent matching and one-shot attempt records; monitor new follow-up delivery and error rates.
- Do not replay historical missed 20h, 48h, 66h, Day4 or Day6 messages.
