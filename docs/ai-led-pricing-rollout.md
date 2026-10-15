# AI-led pricing promotion routing

This per-client feature shares a verified pricing decision between the existing
customer reply and the optional promotion graphic. It does **not** bypass Meta,
WhatsApp Strict RM0, staff takeover, clinical reviews, duplicate checks, or
the 24-hour service window.

## Per-client rollout

In **Settings → AI Behavior → AI pricing graphic decisions**:

- **Off** (default): retain the existing keyword-backed pricing behavior.
- **Shadow**: log AI intent and independent customer/service verification but
  retain the existing reply context and image-trigger behavior.
- **Enabled**: use AI intent plus customer-authored service evidence to decide
  whether a verified promotion can be sent.

The separate **Also allow questions asking for available packages or offers**
option is off by default. With it off, only direct treatment-price enquiries
qualify for the image. Merely consenting to future offers never qualifies.

Set **Shadow** on a test client first. Compare the server's
`[AI pricing shadow]` events to actual enquiries; validate service changes and
ambiguity. Enable on the demo client, send test messages over WhatsApp,
Messenger and Instagram, then enable on a production client only after reviews.
Do not replay old production inbound jobs to test the new mode.

## Configuration and pricing

The existing `sendOnPriceQuery`, promotion validity window and linked service
remain authoritative. An offer can optionally specify a numeric object:

```json
{"pricing":{"currency":"MYR","offer":488,"normal":888}}
```

Use the corresponding **Verified MYR prices** fields in Promotions. Each
multi-package option may have its own `pricing` object. If omitted, the
existing price-copy verification remains the fallback. Readable prices that
conflict with the structured offer amount prevent quotation and auto media.
No database migration is required; values live in the client config JSON.

The AI never supplies an image URL, actual amount, or permitted provider send.
It emits a structured `pricingIntent` alongside the normal reply and
`priceQuery`/`packageQuery` compatibility fields. Service selection must
match a current or immediately previous customer-authored service statement,
not an old ad, CRM label or bot suggestion.

## Troubleshooting

A price decision is not an image delivery receipt. If the channel cannot
send media, the reply can still quote the verified configured amount.
Any failed/unconfirmed media receipt and manually sent duplicates remain under
existing checks. The WhatsApp image queue waits for Strict RM0 confirmation.

For the Neutro regression, replay an inbound customer enquiry naming
`3D 小颜术`, followed by the exact message `请问,做一次多少`. The decision
should classify the request as a price enquiry for 3D and use the configured
RM488 trial promotion. Before enabling production, verify that the promo image,
caption, validity and amount match the clinic's approved offering.
