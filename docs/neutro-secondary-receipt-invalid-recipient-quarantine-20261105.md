# Neutro secondary receipt recipient quarantine (5 November 2026)

## Incident
Render logged 26 `secondary_receipt_batch_invalid status_recipient_invalid` failures from the secondary WhatsApp sender between 15:55 and 21:02 MYT. Signed deliveries are retried by Meta after HTTP 503; the exact rejected `recipient_id` values were not logged. There is also a separate, expected rejection for disabled Business App history import. This PR does **not** change history routing.

## Scope and safety
Only the verified, sender-pinned secondary **live webhook** may capture a status with an unusable recipient. The public parser remains strict.

- Verify original Meta raw-body HMAC, exact WABA/phone, correct status message envelope, WAMID, timestamp, pricing fields, and batch bounds *before* any storage or acknowledgment.
- Record the otherwise unverifiable event in the existing `whatsapp_sender_quarantined_events` table, with `reason=unsupported_whatsapp_event` and `event_field=messages.status_recipient_invalid.<category>`.
- Persist only a SHA-256 fingerprint and one bounded category: `missing`, `null`, `non_string`, `blank`, `oversize`, `control`, `non_ascii`, or `unrecognized_format`. No recipient value, message ID, request body, contact, prompt, or patient data is persisted or logged for this diagnostic.
- On replay, `ON CONFLICT DO NOTHING` makes it idempotent. A sender-wide billable alarm is created only once for a novel, signed event. Do not automatically clear existing alarms or unknown billing gates.
- **Only after the existing sender-locked transaction commits** can the webhook acknowledge; wrong sender, invalid HMAC, malformed status, database errors, and unsupported sender identities still fail closed with the existing retry behavior.
- No contact match, delivery/read confirmation, chat message, AI reply, new lead, appointment, staff takeover, marketing permission, billing gate release, follow-up, retry, or outbound message is authorized by the unmatched record.
- No new timers, migrations, polling, indexing jobs, environment flags, external requests, or recurring diagnostics. The extra quarantine insert happens only for a signed event with an unusable recipient. Repeated 503 attempts should decrease if those are the cause.

## Release verification
1. Confirm backend and browser CI pass. Merge through normal review. Deploy **Neutro only** once with auto-deploy still disabled. The history receiver remains OFF; no changes to AI audience configuration or message sending.
2. Count new unmatched recipient formats without exposing recipient or customer details:

```sql
SELECT event_field, COUNT(*)::int AS unique_events
FROM whatsapp_sender_quarantined_events
WHERE reason='unsupported_whatsapp_event'
  AND event_field LIKE 'messages.status_recipient_invalid.%'
  AND first_seen_at >= TIMESTAMPTZ '<deployment UTC time>'
GROUP BY event_field ORDER BY unique_events DESC;
```

3. Quarantine uses `ON CONFLICT DO NOTHING`, so replay attempts are not counted in `seen_count`. Compare aggregate Render 503 metrics and `status_recipient_invalid` app logs before and after. Do not mistake reduced 503 for proof of delivery; quarantined receipts remain **unmatched**.
4. Verify ordinary secondary `sent`, `delivered`, `read`, `failed` receipts still reconcile only to exact authorized sender + recipient + WAMID. Confirm AI replies (all-contact secondary), both WhatsApp numbers, promo/result media, staff handoff, booking and 2h/6h/20h/48h/66h/Day4/Day6 follow-ups, including opt-outs and delivery uncertainty.
5. Review new `unmatched_provider_billable` alarms and the existing unknown billing gate manually. Never auto-resend, backfill, settle, or clear unknown outcomes.
6. Keep disabled history imports as-is. Historical events may still trigger 503. Handle those only in a separately authorized workflow that is demonstrably independent of secondary live AI and customer imports.

## Expected overhead
Constant-time recipient classification and one SHA-256 hash of the already-bounded signed request only on the invalid-recipient path; one sender-locked transaction and existing quarantine insert only when a signed, structurally verified status has an unusable recipient. This may add small DB work for the first rejected callback, but repeated Meta retries should reduce. No extra Gemini tokens, context-window growth, prompt changes or recurring Neon queries.
