# Telegram Alert Queue Operations

The immediate Telegram alert queue was introduced by migration 020. The schema is intentionally compatible with the older inline-send application code, but the older application does not run the durable queue worker.

## Normal deployment

Migration 020 keeps the database default for `telegram_immediate_alerts.status` as `sent`. New queue-aware code explicitly inserts `pending`. This means an older application version can still insert its historical sent markers without accidentally creating replayable queue rows.

## Before rolling back the application

If possible, let the current version drain immediate Telegram work before switching to an older release.

Check the queue:

```sql
SELECT status, COUNT(*)
FROM telegram_immediate_alerts
WHERE status IN ('pending', 'sending')
GROUP BY status
ORDER BY status;
```

A result with no rows means there is no outstanding immediate Telegram work.

## If an urgent rollback is required

It is safe to run the older application against the migrated schema. Customer-facing WhatsApp, Facebook Messenger, and Instagram processing does not depend on the Telegram queue worker.

Existing `pending` or `sending` Telegram rows will remain in Postgres while the older application is running. They are not lost, but the older application will not deliver them.

When the queue-aware version is deployed again:

- `pending` rows become eligible normally.
- stale `sending` rows are recovered by the immediate-alert worker.
- final-attempt stale recovery remains bounded, so repeated worker crashes cannot retry forever.

Do not manually change outstanding rows to `sent` unless you intentionally want to discard those notifications. Marking them `sent` tells the queue-aware application that Telegram already accepted them.

## Rollback trade-off

Rolling back application code is therefore schema-safe, but not queue-draining. The practical choices are:

1. drain the queue before rollback when there is time, or
2. roll back immediately and accept that outstanding Telegram notifications will resume only when the queue-aware version returns.

The customer messaging path remains independent in both cases.
