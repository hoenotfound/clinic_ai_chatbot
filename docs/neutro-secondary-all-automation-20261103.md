# Neutro secondary WhatsApp: all AI functions for eligible conversations

## Clinic decision (3 November 2026)
Extend secondary WhatsApp beyond all-contact AI replies. New incoming messages
from advertising, direct, imported, old and primary-number customers may
trigger the same supported automated service functions on the secondary number,
subject to sender identity, ownership, consent and Meta sending policies.

## Cutover and backward compatibility
- Existing `WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE=all_contacts` and its original
  timestamp stay unchanged.
- The prior ads-only cutoff (`WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT`)
  remains immutable, preserving already eligible advertising leads and their
  previously enabled, consented sequences.
- The independent flag `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=all_contacts`
  only activates with a fresh
  `WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT` UTC timestamp.
- This timestamp must be on or after the all-contact reply cutoff.
- New non-ad automation requires a customer inbound message with a verified
  sender context, Meta message ID and real source timestamp on or after this
  automation cutoff. No imported/coexistence history messages qualify.
- Do not replay old inbound processing jobs, generate catch-up automatic media,
  or backfill old templates or reminders. Old staff and opt-out decisions remain.

## What it enables for new eligible conversations
- Immediate AI text replies (already enabled under an earlier separate flag)
- AI-selected promotional images and Before & After results, with existing
  media approval, per-message uniqueness, pacing, quiet hours and billing
- Configured 2h/6h service follow-ups and 20h personalized invitation
- Configured, Meta-approved, locally consented 48h and 66h marketing templates
- Lead scoring, summaries, and Telegram alerts for future activity
- Approved 2h/6h videos and other pre-existing features when enabled and safe

## Consent, cost and unsupported cases
- A normal incoming enquiry does NOT equal marketing opt-in.
- Automated follow-ups and marketing templates keep their explicit,
  service-specific, sender-bound recorded marketing consent requirements.
  They also require enabled/approved rules, valid WhatsApp window or approved
  templates, opt-out checks and paid delivery acknowledgment.
- An accepted Meta template may incur charges, especially outside a verified
  ad-origin free-entry window.
- Day 4 and Day 6 use special 7-day free-entry point checks. They remain
  disabled unless the separate scheduler switch is approved and the live
  sender has matching enabled, verified rules and templates. Do not convert
  non-ad contacts to free-entry status or bypass the provider receipt checks.
- The secondary Inbox staff-send control stays disabled. Staff can still
  reply through the WhatsApp Business App.
- Primary WhatsApp, Messenger and Instagram remain unchanged.
- A known active staff handoff/needs-attention or opt-out always blocks
  automated messages. New marketing consent may be recorded only from a
  fresh, explicit customer message through the existing consent flow.

## Release procedure
1. Run PostgreSQL and JS regression tests for both new direct messages and
   old opted-in ad sequences, including SQL selectors, provider timestamps,
   cutoff checks, opt-outs and sender-bound billing.
2. Deploy the code with the prior `ads_only` setting unchanged.
3. Once the updated code is live, update the two automation environment
   variables together, using a **future** UTC timestamp for activation.
4. Verify the resulting environment-triggered Render deployment is live.
5. Check service errors, pending media and follow-up work, and customer
   outbound ledger for unexpected sends.
6. Let natural inbound traffic provide the first end-to-end delivery result;
   do not automatically send to any selected customer as a deployment test.

## Rollback
Set `WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE=ads_only` and leave its
original ad activation timestamp unchanged. The separate all-contact AI
**text reply** flag is independent and can remain enabled. No SQL data
updates or customer-message retries are required to roll back.
