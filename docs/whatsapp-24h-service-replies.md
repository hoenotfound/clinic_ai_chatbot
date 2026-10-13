# Optional 24-hour WhatsApp text service replies

With Strict RM0 on, a separately enabled Tools option permits normal text
replies to a provider-authored customer message no older than 23h58m.
Messages may incur Meta service charges after the monthly free allowance.
This is NOT a Meta RM0 guarantee.

A durable one-shot exception records the outbound message BEFORE calling Meta.
Only provider-accepted WAMIDs with verified Meta pricing type `regular`,
category `service`, and `billable=true` are exempted from the unexpected
charge alarm. Missing, conflicting, or non-service pricing remains an alert. The
billing-alert insertion records **every unexpected billable webhook**, including
marketing, unclassified and amended pricing. It excludes a callback only when
an accepted 24h service reply has matching persisted regular/service Meta proof.
Callbacks that arrive before the provider acceptance record are initially
queued, then cleared only after that matching proof is persisted.
Unknown sends cannot be retried with the same saved message. Chargeable
templates, staff-scheduled messages, automatic follow-ups, interactive
marketing consent prompts, and all media still require the independently
verified CTWA/FEP rules. A definitively rejected send may be retried through
the original saved message ID; an accepted or ambiguous send must not replay.

After merging and deployment, enable in Neutro Sense Tools > Automated
Follow-up > WhatsApp while leaving Strict RM0 on. Send a new organic message
and verify the reply, then check Billing Hub and strict follow-up blocks.

Rollback by turning OFF the additional service-reply checkbox. No activation
timestamp reset or manual database change is needed.
