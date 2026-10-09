# Neutro Sense reply-quality review after October 6 token optimization

Review date: October 9, 2026 (Malaysia time). This is an observational review of the production
Neon database, not a medical-content approval, randomized quality test, or proof that the
optimization caused any changes in conversion.

## Checks performed

- Compared average input tokens per successful Gemini 3.8 Flash request before and after
  deployed PRs #247 and #248. The follow-up reduction was ~84%, reply reduction ~40%.
- Read recent assistant and follow-up entries for pelvic care, 3D contour enquiries,
  pricing/package A/B, treatment explanation, and booking/branch responses.
- For the assistant messages after October 7 03:24 UTC queried, no failed-delivery rows
  were reported in the sample date window. This does not prove all messages were delivered.
- Confirmed AI follow-ups and normal replies remained active after prompt optimization.
- Existing tests in PR #251 cover treatment resets, pricing, packages, branch and bookings;
  no fresh live model replay was performed for this review.

## Human review required before changing clinic marketing copy

Some existing 3D contour promotional media captions describe changing gaps between skull bones,
moving displaced muscles, relieving compressed nerves, and making universal "no side effects"
claims. These are not substantiated in this review and should be clinically reviewed before
continued advertising. The captions come from stored/prescribed promotion media, so changing
the model prompt will not fix the original media claims.

There is also an apparent normal-price difference between a 3D treatment session (RM888) and
one promotional 3D graphic's "original price" (RM1288). Confirm whether this is an intentional
difference between a treatment session and a larger package before rewriting either.

No customer identifiers or transcript excerpts are stored in this audit.
No clinic promotional media, prices, booking workflow, or generated replies are changed by
this pull request.

## Operational follow-up after merge

1. Review a random sample of replies across all three channels for 48 hours, including
   price enquiries, Pelvis A/B choice, 3D+9D questions, booking and human handoff.
2. Track the share of messages accepted, rejected, timed out, and delivered in existing
   observability. Avoid inferring clinical accuracy from successful API calls.
3. Check AI Costs > Cache diagnostics after a reasonable number of new Gemini calls.
   Very short follow-ups can be below the 4,096-token implicit cache threshold.
4. Compare the dashboard's estimated USD costs with provider invoices periodically,
   and configure AI_USD_MYR_RATE only if an explicit exchange-rate estimate is wanted.
