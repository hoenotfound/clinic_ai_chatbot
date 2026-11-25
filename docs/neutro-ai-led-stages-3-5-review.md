# Neutro Sense AI-led stages 3–5: implementation and release audit

## Design
The existing model call interprets customer intent from current conversation history, configured services, verified context and current clinic facts. Context selection remains a retrieval hint, not authority to make a booking, price quote or media send. No new provider call, database query, migration, worker, dependency or clinic configuration write is introduced.

## Reviewed runtime boundaries
| Area | Decision |
| --- | --- |
| Normal configured treatment replies | Preserve a correctly identified model reply; retain evidence-based clinical review and conservative recovery on missing/contradictory metadata. |
| Conversation treatment retrieval | Keep detailed selected facts and bounded compact descriptions/aliases of alternatives. Do not expose unrelated structured price or promotion data. |
| Prior assessment invitation | Reuse already loaded provider-confirmed delivered bot history and the existing invitation evidence matcher; do not query again or treat unsent copy as delivery. |
| Follow-up context | Verified current staff/customer discussion is distinct from old CRM interest. Include up to two detailed treatment contexts; after verified reset exclude earlier topics from commercial retrieval. |
| AI follow-up decision | Reuse send/skip/stop_sequence/human_review. Essential runtime facts are separate from bounded optional writing instructions. |
| Media authorization | Use exact configured asset mappings and canonical model topic. A conflicting or unresolved treatment-specific media decision skips that step without another model call; preserve intentionally general assets and approved fixed captions. Shared keys require a compatible verified treatment. |
| Scheduling continuity | Retain narrow fixed-copy/date correction and actual appointment validation. Preserve an AI explanation before a clearly separable scheduling question instead of replacing the whole line. |
| Pricing and package authorization | Keep explicit current-price evidence, active configured amounts, exact approved caption/artwork, promotion expiry and staff confirmation rules. Avoid adding standing treatment price fields to assessment-first follow-up prompts. |
| Clinical safety and staff ownership | Keep urgent and unresolved clinical review, no unsupported treatment guarantees, staff takeover, cancellation and review gates. |
| Delivery, consent and timing | Keep sender-scoped identity, Meta window/marketing consent, billing, durable one-shot claims, duplicate media, retry and pre-send checks. |
| Other hardcoded rules | Existing RM68 dated campaign, pelvic voucher and verified treatment nomenclature are clinic-specific facts or offer rules rather than general conversation logic. Their full migration to configurable facts requires operator-confirmed config and separate regression coverage. Do not delete them opportunistically. Existing compact-prompt policy retains its scope and feature settings. |

## Remaining evidence
This is a targeted audit of the conversational reply and follow-up paths, not a claim that every hardcoded expression across the whole repository has been eliminated. The full regression suite must pass on the exact PR head. Prompt character/token consumption and model quality must be measured separately; compact alternative descriptions may increase some prompts while omitted standing prices reduce others. No live customer message or manual WhatsApp test is required to run the automated regressions. Observe natural production traffic after an approved deployment.
