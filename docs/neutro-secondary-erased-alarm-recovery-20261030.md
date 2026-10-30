# Neutro second WhatsApp: erased billing-alarm recovery (draft)

Status: **code prepared for review only**. Do not merge, deploy, invoke the
release function, delete the production alarm, or activate secondary outbound
without a separate, supervised operational authorization.

## Why this is necessary

The 29 October 2026 secondary manual send was accepted into an outbound
attempt with an unknown provider outcome. A legitimate privacy purge removed
the customer and send attempt but retained a hashed audit
(`previous_state=unknown`) and the protective
`purged_unresolved_reservation` sender-wide alarm. This was **not** a
confirmed send, confirmed non-send, charge, or free message.

The owner currently cannot access the secondary WhatsApp Business App. A
read-only Meta check showed the number is registered, but its messaging
account has **no active payment method shown**. That can prevent billable
deliveries and does not establish the old message's outcome.

## Two separately audited release types

1. **Verified:** Two distinct reviewers attest to separate actual Business
   App and Meta billing evidence, its SHA-256 fingerprints, a confirmed
   delivery outcome and a compatible confirmed charge outcome.
2. **Risk-accepted UNKNOWN:** If the owner cannot establish either outcome,
   two distinct reviewers explicitly acknowledge **delivery=unknown** and
   **charge=unknown**, a possible later Meta charge, and the rule never to
   retry the erased message. Both external evidence hashes remain NULL;
   no fictional proof of delivery or free pricing may be recorded.

Both require an explicit release authorization at execution, a minimal
privacy-safe review reason, and manual confirmation that a **real signed
Meta status webhook is working on the newly deployed code** and the
**secondary account's payment method is active**. These declarations are
human attestations, not independent API proof. Unknown acceptance does NOT
remove the financial uncertainty or prevent future Meta charges.

Release remains disabled by default with
`WHATSAPP_SECONDARY_ERASED_ALARM_RELEASE_ENABLED`.
The standalone module `whatsappErasedSenderAlarmResolutionService` is
not called by any production endpoint, worker, or scheduled task.

## Narrow transactional safeguards

Under a sender lock, the code requires the exact registered secondary
phone/account and one `purged_unresolved_reservation` alarm with one
observation, a matching single erased-reservation audit record, the original
unknown state and no recorded billable receipt. It rejects open sender
gates/attempts, later provider receipts, multiple or changed alarms, a
previous release, wrong identity, or any enabled secondary outbound flags.

On success it records only the old reservation hash, the truthful review
outcome, risk acceptance, readiness attestations and reviewer identities.
It then removes **only** that exact global purged hold in the same
transaction. The **original erased audit still says unknown**, and no
customer record, message, attempt or send is restored. No provider request
or retry is made. The method returns `sendAuthorized:false` and
`retryAuthorized:false`.

Future suspicious provider receipts can trigger a new alarm and block later
sends. This exception never whitelists future sends or ignores a newly
reported charge. DA CHATBOT cannot prevent staff from manually sending
outside the system in the Business App.

## Release plan when Render build minutes return

- Do not change production now. GitHub CI and disposable PostgreSQL tests
  are the only permitted execution of this draft.
- Deploy reviewed code under supervision with **all second-number outbound
  features disabled**; validate primary WhatsApp, Messenger, and the
  new signed secondary webhook path. Confirm the payment method is active
  in Meta Billing Hub. Do not assume that adding a card proves billing
  for the old message.
- A separate explicit owner approval must be obtained to perform an
  audited, one-time risk release. Two distinct named reviewers must sign
  off; unknown must remain unknown. No raw `DELETE` in Neon.
- Only after the release and independent activation approval may a NEW
  opted-in second-number conversation test AI **text** response and
  signed charge receipts. Do not replay old history or send the erased
  message, and keep media, templates, and follow-ups OFF at first.
