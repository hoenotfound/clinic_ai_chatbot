# Customer data deletion and retention

## Manual deletion

Accounts with the **Delete customer data** capability can permanently delete a
customer from **Contacts > Danger zone**. The confirmation requires typing
`DELETE`.

The purge removes the contact and the database graph rooted at that customer,
including:

- conversation messages and reactions
- pipeline/lead journeys, attribution, scoring, activities and stage history
- notes
- scheduled messages and automated follow-up bookkeeping
- inbound/outbound recovery jobs and WhatsApp retry state
- Telegram alerts tied to the customer/lead
- social provider message-id mappings
- matching pending social attribution and comment-automation rows
- customer media stored in R2

The database deletion and the durable R2 cleanup job are committed in one
transaction. R2 deletion then runs immediately. If R2 is unavailable, the
database purge still remains committed and the cleanup job retries with
backoff. Completed purge jobs are retained for 30 days as a minimal operational
audit and then pruned.

The purge also retains only opaque provider message IDs, WhatsApp reaction
event IDs, standalone Meta referral-event IDs, and Meta comment IDs for 30 days.
These are replay tombstones: if Meta retries an exact deleted message, staff
echo, reaction, referral event, or comment after its normal dedupe row is gone,
the retry is ignored before customer-linked data can be recreated. A reaction
targeting a deleted customer message is also ignored, even if the reaction
event itself is new, so the pending-reaction queue cannot reintroduce the
customer's WhatsApp ID. Standalone referral IDs are SHA-256 event fingerprints
and do not contain the raw PSID/IGSID. A genuinely new provider event unrelated
to deleted customer data is not blocked and may start a fresh customer journey
normally.

Migration `042_customer_data_referral_replay_guard.sql` adds the pending
referral event ID used for this exact-event replay protection. Migration 040 is
historical and must not be edited.

For namespaced R2 deployments (`CLIENT_SLUG` set), cleanup deletes both exact
stored media keys and the customer's permanent/temporary prefixes. Legacy
unprefixed deployments delete only exact media keys recorded in Postgres.
Prefix deletion intentionally fails closed in legacy mode because a shared
bucket cannot prove that `messages/<contact-id>/` belongs to only one client.

## Automatic retention

Automatic retention is disabled by default:

```env
CUSTOMER_DATA_RETENTION_DAYS=0
```

Set it to an integer from **30 to 3650** to enable automatic purging. Example:

```env
CUSTOMER_DATA_RETENTION_DAYS=365
```

A customer's retention age is based on the latest of:

- contact creation/update time
- conversation message time
- lead/CRM update time
- staff-note time

Automatic retention is deliberately conservative. A customer is skipped while:

- the conversation is human-owned
- the customer needs attention
- the customer is explicitly flagged for follow-up
- an open lead has a future follow-up or appointment
- a scheduled message is pending/processing
- inbound processing is still recoverable
- a transient WhatsApp outbound retry is active
- a recent AI follow-up generation lease is active

Candidates are rechecked inside the same transaction that takes the
conversation advisory lock immediately before deletion, so an old candidate
cannot be purged after new activity arrives.

The worker checks retention every six hours, processes at most 25 customers per
sweep, and runs media-cleanup recovery every ten minutes.

## Operational notes

- Enabling retention is destructive. Choose the retention period according to
  the clinic's legal, contractual and operational requirements.
- Keep `CLIENT_SLUG` configured for every client so R2 prefix cleanup can be
  isolated safely.
- A customer who contacts the business again after being deleted is treated as
  a new contact/lead journey.
- Manual deletion is not blocked by scheduled work. Explicit deletion cancels
  the entire customer graph by design.
