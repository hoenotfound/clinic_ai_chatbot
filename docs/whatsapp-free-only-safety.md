# WhatsApp free-only delivery policy (clinic opt-in)

This optional Tools switch is OFF by default. It is **best-effort charge avoidance, not a Meta spending cap or a zero-billing guarantee**. Meta assigns the final billable flag in asynchronous delivery-status callbacks, and other applications with access to the WABA are outside DA Chatbot's control.

## Decision table

| State at send time | Free-form | Approved template |
|---|---|---|
| Direct/organic WhatsApp enquiry, no verified Meta FEP pricing | BLOCK | BLOCK |
| Genuine CTWA referral, but first business reply not sent or not priced | BLOCK | BLOCK |
| CTWA referral, first business reply sent >=24h after first inbound | BLOCK | BLOCK |
| Verified FEP, last customer inbound within 23h58m, FEP before conservative expiry | Allow via serialized provider send | Allow via serialized provider send |
| Verified FEP, last customer inbound older than 23h58m, FEP before conservative expiry | BLOCK | Allow via serialized provider send |
| FEP expiry, 7-day expansion unproven, or pricing missing | BLOCK | BLOCK |
| Meta reports billable callback since strict switch enabled | BLOCK all WhatsApp | BLOCK all WhatsApp |
| Previous send awaiting/unknown Meta pricing | BLOCK all WhatsApp | BLOCK all WhatsApp |

Approved templates also require the existing Meta approval, recorded consent where required, opt-out enforcement, current clinic configuration and provider policy checks.

### Two independent clocks

1. **Activation**: Meta's customer-service window starts with the customer's WhatsApp message. A qualifying entry-point billing window only starts when the business replies within 24 hours. The durable SQL joins the ad's actual inbound message and first business reply inside 24h to Meta's *explicit* `free_entry_point` + `billable=false` pricing event. Ads previews, clicks, ad labels and captured referrals are NOT proof of billing eligibility.
2. **Free-form vs template**: Free-form is blocked 2 minutes before the 24h service window expires. Templates are permitted after the 24h service window only when Meta-approved and still inside the separately verified FEP billing period. The seven-day expiry **does not extend the free-form customer-service window**.
3. **Source**: Only a validated CTWA `source_type='ad'` referral enters the current strict FEP eligibility SQL. Free profile links, QR codes, boosted posts and Page CTA traffic must NOT be treated as paid CTWA seven-day entries. Facebook Page CTA products may have their own FEP rules; they are not currently asserted as 72h or 7d free in strict mode. To support them, add dedicated provider-origin evidence and tests instead of relabeling them `ad`.

### Free-entry duration

Use a conservative 72-hour ceiling with a one-hour buffer (last send before hour 71). Only use the 168-hour ceiling (last send before hour 167) when both `WHATSAPP_FEP_7DAY_VERIFIED=true` and durable local evidence of an actually nonbillable post-72h FEP send exists. A single ad click or the flag alone is insufficient.

**First-message bootstrap limitation:** Strict mode blocks a *new* CTWA conversation's very first business reply because Meta cannot confirm its free-entry pricing until that reply has been sent. To let the initial reply through would relax the guarantee being requested. Do not turn strict mode on for normal clinic AI support without consciously accepting that new CTWA customers may receive no reply. The first-business-reply flow can be tested while strict mode is off, but may entail billing risk.

### Durable delivery and recovery

All DA Chatbot WhatsApp Cloud API sends use one serialized, account-scoped reservation. Follow-up workers pass their saved message and claim IDs, which must match the recipient and claim; their *own* pending record is excluded without ignoring another worker's pending message. A known 4xx refusal releases the slot; provider acceptance is not proof of free billing. A timeout or unknown result stays blocked. A `reserved` state older than 15 minutes may be classified `unknown` by the next guard check, but it is **never automatically released**.

An administrator with both Settings and Tools permissions can reconcile an `unknown` or `awaiting_pricing` reservation only after it has aged 5 minutes in that state, checking the customer's actual chat and official Meta Billing Hub and writing an immutable explanation. A live `reserved` send or a billable callback cannot be overridden. The audit only exempts the original saved message and attempt; the original claimed follow-up slot is never retried. Subsequent slots can resume after reconciliation when all other normal eligibility checks pass.

Billing callbacks store durable warnings and enqueue deduplicated Telegram alerts. Failed notifications remain queued and cause recovery checks every 30 seconds while alerts are outstanding (subject to the alert lease). Tools shows both callback evidence and a link to Meta Billing Hub. **Callback summaries do not equal a complete charge statement.**

## Minimum verification before a live enablement

- Review Meta's actual business number and the outbound account, and confirm the WABA payment method and Billing Hub.
- Test an ordinary direct message: both unverified free-form and template sends are blocked.
- Test a genuine mobile CTWA enquiry: a timely initial reply in nonstrict testing and an explicit FEP nonbillable pricing status appear in Neon; clicks alone are not enough.
- Test a verified recipient shortly before 24h: free-form permitted until the buffered cutoff; after the cutoff, free-form blocked and an approved template allowed if the FEP remains verified.
- Test 72h/168h billing ceilings, manual-send/template/media paths, marketing consent and opt-out.
- Test a crashed reservation, a delayed pricing callback, two concurrent workers and admin audit recovery in the isolated Postgres test suite.
- Reconcile charge data with Meta Billing Hub. Do not describe the optional switch as a literal RM0 guarantee.
