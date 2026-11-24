# Neutro Sense prompt A/B test

Standalone local test. Does not start Render, send WhatsApp messages, modify Neon, or use the chatbot's AI usage writer. Use a trusted local machine with Node.js and repository dependencies installed (`npm ci`). Do not use actual customer conversations or commit config exports/reports.

## Quick start

From the PR branch, obtain a private JSON export of the **original** clinic_config.data (one JSON object). If exporting via psql, use an authorized read-only connection and run `SELECT data FROM clinic_config WHERE id = 1;` using unaligned/tuples-only output. Save outside the repo as config.json. The three stage 1 text-field fingerprints and the stage 2 guardrail/escalation list fingerprints must match the reviewed source. A stale or different export is rejected. Existing local config-fixed.json from the earlier offline test can be reused if these fingerprints still match.

Free offline test (38 scenarios):

```sh
node scripts/neutro-ab.js < config.json > report.html
```

Open report.html in a browser. It measures rendered system prompt characters, not actual tokens or cost.

Optional paid test (10 pairs, up to 20 application-level provider calls). Set NEUTRO_AB_GEMINI_API_KEY in your local shell using a separate authorized Gemini key. Do not paste it into source code or commit it.

```sh
node scripts/neutro-ab.js --live --limit=10 < config.json > report.html
```

For the full 38 scenarios, use --limit=38 (76 application-level calls). On Windows PowerShell, use `cmd /c "node scripts\neutro-ab.js --live --limit=10 < config.json > report.html"` or run the same command in Command Prompt. Use the repository's locked SDK version; transport-level retries may be provider/SDK-controlled. Offline mode is default and does not require an API key.

The report compares the actual production request builder and response parsers, on synthetic conversations, with the same model. A uses the original builder behavior and configuration. B uses the three proposed configuration changes plus the opt-in stage 2 compact conversation policy. That policy consolidates guardrails, escalation, pricing authority and clinic booking rules, and scopes only reviewed nonclinical single-service FAQs when the current customer explicitly identifies one service. Unknown/edited/general/clinical/comparison FAQs remain; indirect, ambiguous, scheduling and broad discovery contexts retain all FAQs. Both arms now use the original configuration for follow-up generation; comment prompts remain untouched. The proposal is not enabled by normal application requests. It includes prompt characters, actual provider token usage, estimated costs with and without reported caching, parsed intent/outcomes, explicit expectations and side-by-side replies. The live test alternates arm order. Missing usage is not counted as zero in totals. Review both responses manually for wording, factual accuracy and medical safety; no automated test can certify these.

This is NOT an end-to-end test of message delivery, graphics, appointment execution, sender routing, language-correction retries or follow-up scheduling. Those need separate integration tests. It does not use actual production customer messages. Do not deploy or apply configuration merely because the benchmark passes.

## Repeat the offline test after pulling stage 2

From an existing clone in PowerShell:

```powershell
git pull --ff-only
cmd /c 'node scripts\neutro-ab.js < "..\config-fixed.json" > "..\report-stage2.html"'
if ($LASTEXITCODE -eq 0) { Invoke-Item "..\report-stage2.html" }
```

Compare the new total and individual prompt character counts to the original offline report. Do not interpret character savings as actual tokens or spend. The next gate is CI and manual review; run live testing only once the candidate is stable.

## Rollout and focused retest

The runtime candidate is disabled by default. The reviewed Neutro Sense clinic can opt in via the boolean `promptOptimization.neutroCompactV2` in the stored configuration after successful live and integration tests. Changing the flag back to false restores the original conversation prompt; the stored SOP, style and closing instructions are never overwritten. The runtime checks the exact reviewed source fingerprints and falls back to the original if they differ. Follow-up generation is unchanged. The benchmark explicitly selects its arm and never relies on the rollout flag. No production data should be changed merely to run this test.

For a focused paid retest, reuse the prior private export and authorized test key:

```powershell
git pull --ff-only
cmd /c 'node scripts\neutro-ab.js --live --cases=pulse-depth,explicit-depth-en,explicit-depth-ms,postpartum-risk,clinical-hifu,monday,closed-day-mixed,explicit-offer,followup-pelvis,followup-malay,compare-face-services,ambiguous-treatment,ambiguous-short-question < "..\config-fixed.json" > "..\live-retest.html"'
if ($LASTEXITCODE -eq 0) { Invoke-Item "..\live-retest.html" }
```

The live test evaluates raw model/parser decisions, not the server's downstream safety guards. The focused retest uses 26 application-level calls. Provider error reports expose HTTP status where available, not raw response bodies. Matched-successful-pair totals are reported independently of incomplete full-run totals.
