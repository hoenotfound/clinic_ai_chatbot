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
Verified numerical prices should be stored for production campaigns. Text with
emoji digits (for example RM 4️⃣8️⃣8️⃣) is accepted only if every money amount in
all configured language copies matches that structured price, and each labeled
original price matches the structured normal price. Conflicting amounts block
automatic media; a raw unverified caption never supplies the price.

The AI cannot authorize image URLs, sale amounts or provider sends. The
existing `priceQuery`, `packageQuery` and `treatment` response fields feed
one verified pricing decision, with no second model request. Service selection prioritizes the current or recent customer-authored service.
For a short early price question with no customer-selected treatment, a single
service inferred independently from the current lead's verified Meta creative
or ad name may establish the initial topic. Ad-only pricing requires the
persisted attribution timestamp to be within seven days and is bounded to at
most four prior customer turns. It only accepts standalone treatment-price
questions (or clear single-session price questions), never deposit, booking,
consultation, assessment, administrative charges, or broad price-list requests.
It fails closed after a topic reset, contradiction, ambiguity, or staff
intervention. An ungrounded model treatment guess may be ignored if the
validated recent ad and customer messages uniquely support a different service.
CRM interest fields
and model guesses never authorize an ad-only treatment. Existing channel
sending rules, duplicate/receipt checks, and verified active sale amounts are
unchanged.

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

## Single approved decision for customer-facing pricing

`src/utils/approvedPricingDecision.js` is the final pricing authorization
between model/context extraction and customer-facing content. A single
approved decision supplies the verified treatment, package names and MYR
amounts to the assessment-first reply guard, quote formatter and promotional
graphic selector. No downstream component should invent a different price,
change the chosen package, or independently veto a valid approved treatment.

**Rollout safety:** In Enabled mode, the verified AI-led pricing decision can
authorize a quote. In Shadow mode, the model's observation is still **not**
authorization: only the separately verified, staff-safe Shadow exception,
numbered pricing-menu selection, or scoped package continuation may affect the
customer reply. A rejected/clinical/staff-taken-over/booking/marketing-opt-out
turn never obtains approval. The complimentary introductory assessment remains
separate from charged treatment packages.

A rejected approval is not allowed to fall back to an observed AI model
decision, including in the text formatter, image selector or service identity
resolver. In Shadow, only a separately verified exception/menu/package choice
uses the new authorization; other original Shadow/Off conversations keep their
legacy path. Related/unpriced treatment conflicts always reject approval,
regardless of the decision's source label.

The numbered selection handler accepts a directly requested treatment price
followed by the bot's numbered pricing menu and a single-digit reply. A
verified customer treatment-list request between the price and menu remains
supported but is no longer mandatory. Both routes require strictly recent
DB-timestamped messages, no intervening staff reply, exactly one configured
treatment per chosen option, and no unrelated administrative/free-assessment
fee question. Parenthetical audience descriptions (e.g. 适合产后) do not
become a second treatment, but explicit mixed-treatment descriptions are
rejected.

The shared decision does **not** bypass provider guards, WhatsApp Strict RM0,
the 24-hour conversation window, marketing permission, customer/staff ownership,
accepted-media URL duplicate checks, or unconfirmed-delivery holds. Those are
side-effect protections, not extra treatment-price classifiers.

Structured `[Pricing authority]` logs report observed-versus-approved
decisions, treatment sources and `approval_reason` codes such as
`no_verified_candidate`, `active_price_unverified`,
`related_treatment_conflict` and `clinical_safety`. The codes identify
failures at the centralized authorization boundary, not every earlier
source/creative validation stage. Migration 077 creates the staff-only
`pricing_decision_audit` table, recording those stages, whether the
accepted text contains the approved price, and whether promotion graphics
were eligible (including the exact skip reason). The optional audit executes
after the text-send outcome, is limited to pricing-related enquiries, and
does not gate Meta sends or inbound retry semantics. No raw message/phone/ad
content is stored. For provider receipts and deferred/cancelled images, use
the separate `result_media_decisions`, `whatsapp_result_media_queue` and
message delivery statuses; eligibility does not imply delivery.


### Context and compound-question safeguards

Ad-context price checks share the same current customer monetary intent as
the central price resolver, including `什么价钱呢？`, `价钱呢？` and
`想了解是什么价钱先呢？`. The ad must still be independently verified
(one configured treatment, fresh attribution, no competing current service,
administrative fee, refusal, pricing objection, or broad price list).

Approved treatment-conflict checks consider the bounded current DB-timestamped
conversation. A new verified customer treatment choice, including selection
from a new numbered menu, takes precedence over older unpriced/related
treatment history. Current explicit conflicting treatment questions never gain
approval. Legacy histories without trusted timestamps use conservative
full-history conflict checks.

Compound questions such as `大概需要做几次呢？价钱呢？` retain safe
non-commercial, non-price advice from the drafted reply in addition to
verified package amounts. No guessed charge, promotion-media delivery promise,
or clinical guarantee is preserved merely because the customer asked twice.

### Regression turn shapes

- #93: Existing staff history from an old session; a new customer-chosen 骨盆
  discussion, two result photos, then `疗程多少钱`. Current-session Shadow
  verification must supply both current pelvic packages without a second
  "which treatment?" reply.
- #524: Customer-named 3D, result image and automated follow-up, then
  `大概需要做几次呢？价钱呢？`. When its treatment is independently
  approved, reply and graphic must use the same 3D RM488.
- #525: Pelvic ad, `什么价钱呢？`, numbered service list, `1`, one
  address question, then `想了解是什么价钱先呢？`. Preserve only genuinely
  verified context; never infer that a bare number always means pelvic.
- #532: Pelvic after result pictures, `请问一次收费是多少呢`, numbered
  menu `1`. Clinical review and malformed AI output must still be
  handled by the independently verified menu path, not unverified guesses.

A real WhatsApp provider send and a Render deployment smoke test are still
required before turning on Enabled for Neutro. Leave its production
`aiPricingIntentMode=shadow` and `assessmentFirstPricingEnabled=true`
until the test and independent review pass.
