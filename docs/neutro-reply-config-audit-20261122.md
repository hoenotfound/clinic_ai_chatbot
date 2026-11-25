# Neutro Sense reply-guidance config migration and hardcode audit (2026-11-22)

## Production configuration change

Project: `delicate-credit-82369573` (the Neutro Sense TCM production Neon project, Singapore).
Table: `clinic_config`, row `id=1`; identity checked as `Neutro Sense TCM Centre`, `tcm_clinic`.

Updated **only** these two JSONB keys using a conditional, timestamp-checked row update:

- `sop`: added `ONE-SESSION BEFORE & AFTER RESULTS` and examples for “一次就见效果吗？”.
- `messagingStyle`: added `RESULT QUESTIONS: ANSWER FIRST`, and moved the already-existing `APPOINTMENT VALUE-FIRST (NEUTRO)` section near the beginning. This matters because follow-up prompt building reads only the first 2,400 characters of messaging style. No wording or conditions were deleted from the moved appointment section.

The new result policy says a confident **yes about a verified one-session visual example**, followed by a short individual-variation note, **not** an assurance of improvement for every customer. Unverified session counts must not be represented as one session.

No prices, service data, promos, marketing permissions, template metadata, ad attribution, follow-up timing, staff takeover, branch records, or sender credentials were changed.

## Shared code cleanup

Removed the clinic-only reply examples from `src/utils/systemPrompt.js`:
- `NEUTRO FIRST-SESSION RESULT QUESTIONS` (PR #705)
- `NEUTRO ASSESSMENT VALUE FIRST` (conversation)
- `NEUTRO VALUE-FIRST INVITATION` (follow-up)

Generic answer-first/booking continuity and the configured `sop`, `messagingStyle`, and `closingPlaybook` injection remain. The source and tests now prove that editable clinic settings supply the example wording.

The clinic-specific `neutroWombNamingRule` stays in code **for now** because it is only injected when an active, verified Package A contains 子宫草药护理. Moving that content as unconditional SOP text would risk promising an unconfigured treatment inclusion.

## Other hardcoded text found: priority audit

| Source | Hardcoded content | Decision |
|---|---|---|
| `src/utils/neutroBreastRm68Campaign.js` | RM68 campaign opening, reminder/caption, December 5-6 dates, inclusions, and replies | **Next migration candidate.** Move approved campaign copy and dates into structured promotion/first-reply config; retain code expiry and independent consent, pricing, booking and media gates. Do not substitute a general SOP. |
| `src/utils/initialOfferReplyGuard.js` | Chinese/English/Malay introductory assessment/invitation phrases and an RM100 voucher mention | **Next candidate.** Move adjustable words to validated per-service templates. Keep customer-verified service gating, free/paid boundaries and voucher eligibility in code. |
| `src/services/neutroSubsequentPricingService.js`, `src/utils/neutroReviewContinuation.js` | Clinic-specific multilingual second-session/review clarification phrases | **Next candidate.** Extract text templates without changing verified pricing, medical review or staff handoff decisions. |
| `src/services/whatsapp131060Recovery.js` | Treatment-selection button titles and identifiers | **Needs separate design.** Existing Meta recovery/ID and customer-intent semantics must remain stable. Could source approved titles from a config allowlist once validated. |
| `src/utils/systemPrompt.js` | Package A terminology equivalence, assessed free introduction and RM100 voucher safeguard wording | **Keep guarded for now.** Some details are conditional on live offers and business flags, not just style. Consider a structured `careTerminology` and `assessmentOffer` config in a separate migration with explicit active-offer checks. |
| `src/utils/appointmentInviteContinuity.js` | Multilingual time/date recognition and safe booking clarification templates | **Keep continuity logic.** Template text could become configurable later; do not move date recognition or confirmation guards into SOP. |
| `src/services/neutroSecondaryGeneralMarketingTemplates.js` | Meta-approved template bodies and language-specific IDs | **Leave as-is pending separate approved-template synchronization.** Free-form config edits cannot replace approved Meta templates. |

This audit does **not** authorize promotional blasting, template submission, or changes to pricing, clinical eligibility, or campaign availability.

## Post-deployment verification

1. CI must pass: backend tests including config-driven prompt tests, plus portal/browser checks.
2. Merge normally to `main`; Neutro Render auto-deploy is OFF, so trigger **one** manual deploy after CI.
3. Confirm deployed commit matches merged commit and Render status is `live`.
4. Recheck Neon `clinic_config` and confirm the two new config sections remain present.
5. Do not send live customer messages just to test the writing style. Check future approved replies in Inbox.

## Rollback

To revert the code removal, revert this PR and redeploy. The database edit is additive and can be rolled back separately by removing the exact `ONE-SESSION BEFORE & AFTER RESULTS` and `RESULT QUESTIONS: ANSWER FIRST` blocks and restoring the placement of the existing appointment section. Do not overwrite the entire JSONB `data` value or roll back unrelated config updates.
