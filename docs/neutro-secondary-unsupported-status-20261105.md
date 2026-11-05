# Secondary WhatsApp: safe unsupported status handling (5 Nov 2026)

## Incident
After Neutro's 5 Nov release, signed secondary Meta callbacks repeatedly failed with `secondary_receipt_batch_invalid status_value_unsupported`, resulting in HTTP 503 and provider retries. The existing secondary parser accepts only `sent`, `delivered`, `read` and `failed`. The raw unsupported status was intentionally never logged, so do not assume which Meta value was involved.

## Change
- **Do not mark unknown statuses as delivered.** Continue to recognize only the existing four delivery states for messages, billability checks and reconciliation.
- Only in the signed, sender-scoped webhook handler, accept a structurally valid unknown lowercase status as a **quarantined, unmatched event**. The public parser remains strict.
- Reuse `whatsapp_sender_quarantined_events` (existing table and allowed `unsupported_whatsapp_event` reason), keyed by a SHA-256 fingerprint derived from sender-verified identifiers and event fields. Store only a bounded status label in `event_field` (e.g. `messages.status.played`) and the configured secondary WABA/phone IDs. No raw payload, recipient identifier, WAMID, message content or access token is stored in quarantine.
- Write the quarantine and any supported statuses from the same signed batch within the existing sender-locked database transaction. Respond success **only after COMMIT**. A failed database write, invalid HMAC, mismatched sender/phone, malformed recipient or invalid status shape still fails closed, retaining provider retries.
- For unexpected billable statuses, keep the sender-wide `unmatched_provider_billable` alarm for manual review. Never associate that receipt with a customer or release a billing gate.
- Exact replay fingerprints are idempotent and do not duplicate charges or message sends. Historical unknown follow-ups/images are not resent.
- No new migration, timers, network requests or polling. Primary WhatsApp and social channels are unchanged.

## Release verification
1. Confirm CI tests pass, merge one PR and deploy Neutro only once. Do not enable auto-deploy.
2. Check Render post-deploy logs for `status_value_unsupported`, 503 counts and app readiness.
3. Inspect a *count-only* query without exposing customer data:
   ```sql
   SELECT event_field, COUNT(*) AS events
   FROM whatsapp_sender_quarantined_events
   WHERE reason='unsupported_whatsapp_event'
     AND meta_phone_number_id='<secondary phone ID>'
     AND first_seen_at >= '<deployment timestamp>'
     AND event_field LIKE 'messages.status.%'
   GROUP BY event_field ORDER BY events DESC;
   ```
4. If unknown statuses are present, evaluate their provider semantics before ever promoting any to customer delivery states. Do not manually clear billing alarms or resend unknown outcomes.
5. Confirm signed secondary `sent/delivered/read/failed` callbacks remain recorded normally; compare traffic and bandwidth across similar operating periods. A reduction in 503 alone is not proof of full delivery or video-cache effectiveness.
