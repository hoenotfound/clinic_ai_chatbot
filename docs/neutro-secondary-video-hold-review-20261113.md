# Neutro secondary WhatsApp: video follow-up receipt and hold repair

## What was found (13 Nov 2026, MYT)

- Contact 8930 / message 16938 (4 Nov, 16:53): 2-hour pelvic video. No saved provider WAMID and no matched signed Meta receipt. Delivery and charge remain **unknown**. The original video MUST NOT be replayed. Earlier accepted replies were read, and the AI politely closed the out-of-area inquiry after the customer said Johor Bahru.
- Contact 9053 / message 19328 (13 Nov, 17:15): 6-hour pulse-wave video. Meta accepted with a WAMID, then sent a signed matching `failed` receipt. The original Meta callback did not retain its numeric failure code or full detail. It cannot be recovered retrospectively from the saved data. The unique 5.9MB video exists in R2, but its encoding was not checked.
- Secondary sender had zero sender-wide billing alarms. 94 of the 96 recorded automated MP4 follow-ups from 1 Nov were read/delivered, one failed, one unknown. The account has a saved payment method. This does **not** prove an individual message was not billed.

## Code change

1. Future HMAC-verified secondary `failed` callbacks save only the numerical Meta error code in `messages.delivery_error`. No raw `errors`, title, media URL or customer data is added to logs or database diagnostics. New billing-hold staff alerts include that verified code when available.
2. The secondary follow-up discovery and its final pre-send SQL now exclude a confirmed AI goodbye to a remote customer. A newly initiated customer enquiry after the closing reply is still eligible under existing rules. Existing `谢谢` / distance / explicit opt-out guards are kept.
3. Migration 128 adds a separate append-only-style audit for an **individual, externally reviewed** unknown billing hold. `releaseReviewedSecondaryUnknownHold` is not called by any application route or worker. It is OFF by default and requires the operator to deliberately set `WHATSAPP_SECONDARY_MANUAL_UNKNOWN_HOLD_RELEASE_ENABLED=true` in an isolated trusted operator environment.
4. The offline script only runs with `--apply`, an exact reservation ID, two distinct human reviewer identifiers, a non-sensitive internal evidence ticket, and all three affirmative human checks. It requires the matching sender/contact/message/gate and signed failure or a truly unconfirmed no-WAMID attempt. It rejects billable, delivered/read or contradictory receipts and any sender-wide alarm. It clears only the exact contact gate; the original attempt remains `unknown` to preserve late-receipt investigation. No original send, automatic follow-up catch-up or retry is triggered.

## Operator runbook, never run without evidence

Check the exact conversation and outgoing message in Inbox and the WhatsApp Business App. Check the **exact sender and period** in Meta Billing Hub, including unsettled charges. Two independent staff reviewers must record what they found. For a signed failure also verify the signed failed callback for its exact accepted WAMID; for no-WAMID uncertainty, verify that no matching receipt exists, that the attempted message is not already visible as delivered in the Business App, and confirm no charge. If any evidence conflicts or is unavailable, leave the gate `unknown` and escalate to Meta support.

In an authenticated, **separate** operator shell with migration 128 present and after manual approval:

```sh
# Explicitly opt into one isolated manual procedure in that shell only.
WHATSAPP_SECONDARY_MANUAL_UNKNOWN_HOLD_RELEASE_ENABLED=true \
  node scripts/releaseNeutroSecondaryUnknownHold.js \
  --apply --reservation-id <reviewed-uuid> \
  --release-basis <signed_failed-or-unconfirmed_no_wamid> \
  --first-reviewer <first-operator> --second-reviewer <second-operator> \
  --evidence-ticket <internal-ticket-id> \
  --confirm-billing-no-charge --confirm-business-app-reviewed \
  --confirm-original-never-retry
```

The placeholders above are not executable inputs. The CLI does not verify the Billing Hub or staff identity by itself, and a successful release does not prove non-delivery. It must not be exposed over HTTP. Audit rows should never be deleted or rewritten.

## Release safety

- This PR does not change message-sending authorization or the primary WhatsApp and Messenger senders.
- No existing customer message or held reservation is modified by merging code.
- Apply migration 128 only with the intended production rollout, following backup and CI checks.
- Confirm new signed provider failures display a code and hold only their originating contact.
- Verify a simulated out-of-area goodbye blocks both follow-up discovery and the last pre-send check, while an active customer enquiry remains eligible.
- Do not claim Peggy's actual Meta failure code or video codec was verified. Those values are not in the existing receipt ledger.
