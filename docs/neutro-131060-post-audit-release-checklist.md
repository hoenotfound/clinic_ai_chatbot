# Neutro secondary 131060 recovery: post-audit safety contract

Date: 12 November 2026

This note accompanies PR #595. It is a release checklist, not an authorization
for marketing sends or a way to infer a treatment from an unreadable webhook.

## Expected service behavior

1. A signed secondary-sender Meta 131060 event can receive the existing,
   one-shot treatment-selection menu when sender, provider, billing and ownership
   conditions pass.
2. The first eligible 2h, then 6h, then 20h service reminder may proceed without
   a treatment choice **only when the specific recovery menu has confirmed
   sent/delivered/read status**. A later failure must block the final send check.
3. A verified WhatsApp Business App explanation does not convert this into a
   treatment-specific promotion or automatically disable follow-ups. An explicit
   Staff takeover, unresolved staff promise, medical concern, appointment,
   opt-out or staff question still applies its normal hold.
4. A second unreadable customer event does not count as a readable selection or
   create another seven-day menu. Preserve the prior accepted recovery anchor
   while it remains in the original 24h customer-service window. A real readable
   customer reply stops the old no-selection sequence.
5. Messages sent without readable customer treatment evidence are neutral text,
   never result images, videos or AI-personalized treatment/price offers.
   Language may follow verified staff/customer conversation; otherwise Chinese.
6. The 24h customer service window is measured from the actual customer
   message, **never** from the recovery menu or staff reply. Quiet hours,
   skipped overdue work, one-shot claims and delivery uncertainty still apply.
7. 48h/66h/Day4/Day6 remain marketing/template workflows with their existing
   explicit treatment-scoped consent and billing restrictions. They must not be
   enabled by a mere unsupported message or recovered menu.

## Regression and operational checks

- Unit SQL assertions: menu provider evidence, sender binding, staff reply,
  reported delivery status, repeat 131060, readable customer cancellation.
- Migrated PostgreSQL: no menu, accepted-but-pending menu, delivered menu,
  staff explanation, second unreadable message, failed callback, opt-out,
  first readable customer response and final send recheck.
- Returning-contact AI context: remove only the database-proven unreadable
  placeholder, keeping real older staff and patient history.
- Message mutations: startup reconciliation of a targetless edit notice and
  target-matched edit when the customer user ID is NULL.
- Marketing: compile 48h/66h/96h/144h candidate, due-time and recheck SQL with
  the live legacy-staff and recovery flags enabled.
- Verify actual Render instance and service startup logs after deploy. Do not
  backfill old attempts, reset provider acceptance, or send a blast as a test.

## Rollback

Revert the PR's merge commit through a reviewed GitHub PR, then deploy the
revert to the existing manually deployed Render service. Do not simply disable
the legacy staff flag: that would restore the formerly broad all-contact AI
audience and could message historical customers.
