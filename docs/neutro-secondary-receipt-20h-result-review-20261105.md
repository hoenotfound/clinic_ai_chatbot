# Neutro secondary WhatsApp receipt / 20h / result-media review (2026-11-05)

## Production findings (read-only)

- Render repeatedly returned a 503 while staging HMAC-signed secondary Meta delivery receipts: `secondary_receipt_batch_invalid status_recipient_invalid`. The reason was a strict numeric-only recipient check. The exact value of the affected Meta `recipient_id` was **not** captured, so the fix is defensive, not a claim that every 503 is resolved.
- Three 20-hour follow-up claims on 4–5 November had no saved message. The worker imported `createPersonalized20h` but called undefined `personalize20h` inside a broad exception handler. This is a deterministic pre-send failure.
- Nine secondary result-media jobs expired early: **eight** after the customer sent a newer inbound message; **one** after a staff message. None reached its deadline or had an accepted Meta media ID. The existing cancellation behavior was correct. No expired jobs are requeued or sent to customers.

## Changes

### Safe receipts

- A Meta-signed secondary callback with a valid E.164 `+<digits>` recipient is normalized to the equivalent digits and can reconcile **only** against exact sender, WABA, phone, bound conversation, recipient and reserved WAMID.
- When the signed recipient is an opaque/masked, bounded string, store an **unmatched** fingerprinted receipt. Do not perform a contact lookup, update any customer message, confirm a provider delivery, auto-settle charges, unlock a sender gate, or retry a send.
- A billable unmatched event retains the existing sender-wide safety alarm. Unknown recipient IDs should be investigated against Meta/WhatsApp App history. No customer identifiers, raw status payloads or access tokens are logged.
- Missing, oversized or unsafe recipient values, incorrect sender WABA/phone, malformed Meta WAMIDs, bad signatures and unsupported fields still fail closed.
- Avoid adding a retry or turning a 503 into HTTP 200 unless durable recording has succeeded. Actual reduction in retries must be checked after one production deployment.

### Secondary 20h copy

- The pre-send personalization step now references the existing function correctly; no new prompt policy, clinic pricing, package, booking or media authority is introduced.
- Unexpected failures now store an allowlisted, non-personal phase marker (e.g. `sender_followup_before_save_ai_generation`) to make follow-up issues diagnosable. It does not contain patient details, prompts, transport exceptions or error text.
- Preserve one-shot behavior. **Do not replay** historical unknown attempts, since provider acceptance or later booking is not established. Only new due attempts qualify.

### Before & After images

- No backfill, retries or queue relaxation. Existing cancellation on customer reply or human intervention is the intended behavior, verified by read-only job audit.
- Regression test checks that pending-only cancellation keeps opt-out, newer customer messages, staff takeover and provider-evidence guards. No existing delivered/read image is rewritten.

## Consolidated Neutro-only deployment (not performed by this PR)

1. Confirm GitHub backend and portal CI pass. Do not repeatedly deploy on each commit.
2. If the combined release is approved, deploy latest `main` to **Neutro only** once (auto-deploy stays off). New bandwidth flags remain OFF until the environment can be enabled deliberately, ideally in the same planned release.
3. Inspect aggregate `status_recipient_invalid` and HTTP 503 counts; determine whether opaque receipt handling changes the observed retry storm. Review unmatched/billable alarms rather than clearing them.
4. Check a **new** eligible 20-hour slot with a consented ad lead; verify the AI copy is generated and the single Meta send is accepted. Do not backfill historical one-shot failures or force sends to customers.
5. Confirm a fresh secondary treatment inquiry sends the correctly authorized promotion and result images, while any newer customer reply or staff takeover still cancels queued old images.
6. Confirm the primary WhatsApp, Facebook Messenger and Inbox behaviors remain unchanged. Observe sender-bound delivery receipts, bandwidth usage, Neon reads and service memory.

The fix does not claim all external proxy 503s are solved, and does not prove future behavior until live verification.
