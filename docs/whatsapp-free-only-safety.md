# WhatsApp free-only delivery policy (clinic opt-in)

This optional Tools switch is OFF by default. It is **best-effort charge avoidance, not a Meta spending cap or a zero-billing guarantee**. Meta assigns the final billable flag in asynchronous delivery-status callbacks, and other applications with access to the WABA are outside DA Chatbot's control.

## Decision table

| State at send time | Free-form | Approved template |
|---|---|---|
| Direct/organic WhatsApp enquiry, no verified Meta FEP pricing | BLOCK | BLOCK |
| Genuine inbound CTWA ad referral, no business reply yet, first text reply before 24h cutoff | Allow exactly one account-serialized first text reply; wait for Meta free-entry pricing | BLOCK until Meta confirms free-entry pricing |
| CTWA ad referral, first business reply now too late (24h expired) | BLOCK | BLOCK |
| Verified FEP, last customer inbound within 23h58m, FEP before conservative expiry | Allow via serialized provider send | Allow via serialized provider send |
| Verified FEP, last customer inbound older than 23h58m, FEP before conservative expiry | BLOCK | Allow via serialized provider send |
| FEP expiry, 7-day expansion unproven, or pricing missing | BLOCK | BLOCK |
| Meta reports billable callback since strict switch enabled | BLOCK all WhatsApp | BLOCK all WhatsApp |
| Previous send awaiting/unknown Meta pricing | BLOCK all WhatsApp | BLOCK all WhatsApp |

Approved templates also require the existing Meta approval, recorded consent where required, opt-out enforcement, current clinic configuration and provider policy checks.

### Two independent clocks

1. **Activation**: Meta's customer-service window starts with the customer's WhatsApp message. For a genuine, persisted CTWA ad referral, Meta describes the first business reply within 24 hours as free and as the action that opens the free-entry period. Strict mode therefore permits **one initial text reply** before the billing callback, only when the inbound Meta message ID, actual paid-ad referral, recipient, own saved outbound ID and 23h58m cutoff all match; the account-wide send reservation prevents a second message. **Every later strict-mode message** requires Meta's actual `free_entry_point` / `billable=false` pricing evidence for that first reply. Ads previews, clicks, ad labels and stale CRM attribution are NOT enough.
2. **Free-form vs template**: Free-form is blocked 2 minutes before the 24h service window expires. Templates are permitted after the 24h service window only when Meta-approved and still inside the separately verified FEP billing period. The seven-day expiry **does not extend the free-form customer-service window**.
3. **Source**: Only a validated CTWA `source_type='ad'` referral enters the current strict FEP eligibility SQL. Free profile links, QR codes, boosted posts and Page CTA traffic must NOT be treated as paid CTWA seven-day entries. Facebook Page CTA products may have their own FEP rules; they are not currently asserted as 72h or 7d free in strict mode. To support them, add dedicated provider-origin evidence and tests instead of relabeling them `ad`.

### Free-entry duration

Use a conservative 72-hour ceiling with a one-hour buffer (last send before hour 71). Only use the 168-hour ceiling (last send before hour 167) when both `WHATSAPP_FEP_7DAY_VERIFIED=true` and durable local evidence of an actually nonbillable post-72h FEP send exists. A single ad click or the flag alone is insufficient.

**First-reply exception and limitations:** Strict mode permits the one Meta-qualified first text reply for a genuine CTWA ad referral while its initial 24-hour service window is still open. It does **not** send initial images, templates or voice as bootstrap messages, nor permit direct/organic/unverified/expired referrals. The first reply's actual free billing is still confirmed **after** Meta accepts/delivers it. If Meta rejects it or unexpectedly marks it billable, later strict-mode sends remain blocked. This is risk-managed sending based on Meta's first-reply rules, not a contractual zero-charge guarantee. Subsequent text replies and approved templates must wait for Meta confirmation; they can be briefly delayed.

### Temporary strict-policy deferrals do not consume follow-up slots

The scheduler runs a read-only billing preflight before claiming a slot. If
another WhatsApp request wins the account-wide reservation in the short gap
between preflight and the final Meta send, the strict provider guard rejects
the template **before Meta is called**. The worker first persists the outgoing
message as `cancelled`, then marks the attempt as
`FREE_ONLY_POLICY_DEFERRED_NO_PROVIDER_SEND`.

A subsequent sweep may reuse that slot **only** when all of the following
remain true: the attempt is `cancelled` with that exact reason, its WAMID is
NULL, and its saved outgoing message is `cancelled` with no WhatsApp provider
ID. The claim is atomically reactivated under the existing per-conversation
Postgres advisory lock and unique slot constraint. Its prior cancelled Inbox
message remains available as an audit record.

Meta-accepted, unknown, failed, manually cancelled, opt-out/consent-denied,
and any potentially delivered sends are never retried through this exception.
Ordinary schedule deadlines, clinic consent, quiet hours, verified free-entry
evidence and all preflight/provider safeguards continue to apply. A temporary
block can still lead to a missed reminder if these legitimate constraints
cannot be satisfied before the free-entry period expires.

### Durable delivery and recovery

All DA Chatbot WhatsApp Cloud API sends use one serialized, account-scoped reservation. Follow-up workers pass their saved message and claim IDs, which must match the recipient and claim; their *own* pending record is excluded without ignoring another worker's pending message. A known 4xx refusal releases the slot; provider acceptance is not proof of free billing. A timeout or unknown result stays blocked. A `reserved` state older than 15 minutes may be classified `unknown` by the next guard check, but it is **never automatically released**.

An administrator with both Settings and Tools permissions can reconcile an `unknown` or `awaiting_pricing` reservation only after it has aged 5 minutes in that state, checking the customer's actual chat and official Meta Billing Hub and writing an immutable explanation. A live `reserved` send or a billable callback cannot be overridden. The audit only exempts the original saved message and attempt; the original claimed follow-up slot is never retried. Subsequent slots can resume after reconciliation when all other normal eligibility checks pass.

Billing callbacks store durable warnings and enqueue deduplicated Telegram alerts. Failed notifications remain queued and cause recovery checks every 30 seconds while alerts are outstanding (subject to the alert lease). Tools shows both callback evidence and a link to Meta Billing Hub. **Callback summaries do not equal a complete charge statement.**

## Minimum verification before a live enablement

- Review Meta's actual business number and the outbound account, and confirm the WABA payment method and Billing Hub.
- Test an ordinary direct message: both unverified free-form and template sends are blocked.
- Test a genuine mobile CTWA enquiry while strict mode is active in a controlled clinic: exactly one initial **text** reply is allowed before the Meta pricing receipt, a second send is blocked until the receipt, and later messages require explicit FEP nonbillable pricing status in Neon. Clicks alone are not enough.
- Test a verified recipient shortly before 24h: free-form permitted until the buffered cutoff; after the cutoff, free-form blocked and an approved template allowed if the FEP remains verified.
- Test 72h/168h billing ceilings, manual-send/template/media paths, marketing consent and opt-out.
- Test a crashed reservation, a delayed pricing callback, two concurrent workers and admin audit recovery in the isolated Postgres test suite.
- Reconcile charge data with Meta Billing Hub. Do not describe the optional switch as a literal RM0 guarantee.
