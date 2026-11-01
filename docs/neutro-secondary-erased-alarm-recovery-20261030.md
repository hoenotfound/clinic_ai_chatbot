# Neutro second WhatsApp: reviewed multi-erasure billing-alarm recovery (draft)

Status: **feature disabled by default**. Review and merge are source-control
preparation only, not approval to deploy, invoke the release function, delete
the production alarm, or activate secondary outbound. Those operations each
require separate supervision and evidence.

## Why this is necessary

The 29 October 2026 secondary manual send was accepted into an outbound
attempt with an unknown provider outcome. A legitimate privacy purge removed
the customer and send attempt but retained a hashed audit
(`previous_state=unknown`) and the protective
`purged_unresolved_reservation` sender-wide alarm. This was **not** a
confirmed send, confirmed non-send, charge, or free message.

On 1 November 2026, a supervised AI reply for contact 8863 was recorded
UNKNOWN. The contact and reservation were then deleted at 18:53 MYT under
a customer-data erasure, leaving a **second** historical UNKNOWN audit
alongside the 29 October record and **one new sender-wide alarm**.
The user's recreated contact 8871 is the same WhatsApp number, not an
independent test recipient.

Meta now reports a payment method on file, but that does not establish that
either old message was sent, delivered, free, or billed. One unmatched signed
status was observed at 12:37 MYT, before the latest erasure. No receipt
links to either erased reservation.

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
human attestations, not independent API proof. The standalone function checks
that two different reviewer identifiers are supplied, but it cannot validate
their real-world identities. The executing operator must independently verify
both reviewers' identities and authority outside this service. Unknown acceptance does NOT
remove the financial uncertainty or prevent future Meta charges.

Release remains disabled by default with
`WHATSAPP_SECONDARY_ERASED_ALARM_RELEASE_ENABLED`.
The standalone module `whatsappErasedSenderAlarmResolutionService` is
not called by any production endpoint, worker, or scheduled task.

## Narrow transactional safeguards

Under a sender lock, the code requires the exact registered secondary
phone/account, exactly one `purged_unresolved_reservation` alarm with one
observation and a matching latest erased reservation hash. It also loads
**every historical erased audit** and its existing immutable resolution.
Every outstanding erased UNKNOWN needs a **separate independent review**
matching that specific reservation hash; any missing, duplicate, unrelated,
unapproved or unsupported record prevents the entire release.
Already individually resolved histories cannot substitute for an unreviewed
attempt. All review records and the sole alarm removal happen in one
transaction, or none occur.

The release rejects open sender gates/attempts, later provider receipts,
multiple or changed alarms, a previous release, wrong sender identity,
and any enabled secondary outbound flags. It also rejects attempts to
reconcile a new message using an old erased hash.

On success it records only the old reservation hash, the truthful review
outcome, risk acceptance, readiness attestations and reviewer identifiers.
The audit table rejects later UPDATE/DELETE attempts through a database
trigger (a database administrator retains the ability to administer schema).
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
- A separate explicit owner approval must be obtained at execution
  for this exact alarm, with the known risk of later Meta charges.
  Two **genuine independent authorized reviewers** must attest to **both**
  outstanding historical UNKNOWN attempts. Names and evidence must be
  provided by real people, not invented by an assistant. Owner consent
  to code changes does not substitute for two approvals.
  Keep the existing older and newer erased audits intact. No raw
  `DELETE` in Neon. The currently available evidence is insufficient
  to claim a previously sent or free message.
- Only after the release and independent activation approval may a NEW
  opted-in second-number conversation test AI **text** response and
  signed charge receipts. Do not replay old history or send the erased
  message, and keep media, templates, and follow-ups OFF at first.
