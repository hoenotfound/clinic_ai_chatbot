"use strict";

// Standalone benchmark. Never starts the app, calls its send pipeline, or records usage in Neon.
const fs = require("node:fs");
const config = require("../src/config/clinicConfig");
const { hydrateBusinessConfig } = require("../src/config/industryProfiles");
const { buildGeminiRequest } = require("../src/services/geminiService");
const { parseAiReplyResult, canonicalConfiguredService } = require("../src/utils/aiReplyResult");
const { parseFollowUpAiResult } = require("../src/utils/followUpAiResult");
const { estimateAiUsage } = require("../src/services/aiCostEstimator");
const { previewConsolidation } = require("./preview-neutro-prompt-consolidation");
const cases = require("./config-proposals/neutro-ab-cases.json");
const MODEL = "gemini-3.8-flash";

function withConfig(data, fn) {
  const previous = { ...config };
  try {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, hydrateBusinessConfig(structuredClone(data)));
    return fn();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, previous);
  }
}
function requestFor(data, scenario) {
  return withConfig(data, () => buildGeminiRequest(scenario.history, {
    surface: scenario.surface, channel: scenario.channel,
    replyLanguage: scenario.lang, isFirstMessage: scenario.history.length === 1,
    followUpContext: scenario.followUpContext || null,
  }, MODEL).request);
}
function checksFor(data, scenario, raw) {
  return withConfig(data, () => {
    const result = scenario.surface === "follow_up" ? parseFollowUpAiResult(raw) : parseAiReplyResult(raw);
    const actual = { outcome: result.outcome, action: result.action,
      priceQuery: result.priceQuery, packageQuery: result.packageQuery,
      treatment: result.details?.treatment, bookingReady: result.bookingReady,
      serviceQuery: result.serviceQuery, serviceQuerySource: result.serviceQuerySource,
      pricingStage: result.pricingStage, promotionOption: result.promotionOption,
      reviewType: result.reviewType, appointmentPreference: result.details?.appointmentPreference };
    const checks = Object.entries(scenario.expect || {}).map(([field, expected]) => {
      const wanted = field === "treatment" ? canonicalConfiguredService(expected) || expected : expected;
      return { field, expected: wanted, actual: actual[field],
        pass: Array.isArray(wanted) ? wanted.includes(actual[field]) : wanted === actual[field] };
    });
    return { valid: true, reply: result.text ?? result.message ?? "", actual, checks };
  });
}
function usageOf(response) {
  const u = response.usageMetadata || {};
  const number = key => Number.isSafeInteger(u[key]) && u[key] >= 0 ? u[key] : null;
  const promptTokens = number("promptTokenCount"), outputTokens = number("candidatesTokenCount"),
    thinkingTokens = number("thoughtsTokenCount"), cachedTokens = number("cachedContentTokenCount");
  const event = { provider: "gemini", model: MODEL, promptTokens, outputTokens, thinkingTokens, cachedTokens };
  return { ...event, estimatedCostUsd: promptTokens === null || outputTokens === null
    ? null : estimateAiUsage(event).costUsd,
    uncachedCostUsd: promptTokens === null || outputTokens === null
      ? null : estimateAiUsage({ ...event, cachedTokens: 0 }).costUsd };
}
async function evaluate(data, scenario, generate) {
  const request = requestFor(data, scenario);
  const row = { promptChars: request.config.systemInstruction.length, mode: generate ? "live" : "offline" };
  if (!generate) return row;
  const started = Date.now();
  try {
    const response = await generate(request);
    row.latencyMs = Date.now() - started;
    row.usage = usageOf(response);
    try { Object.assign(row, checksFor(data, scenario, response.text)); }
    catch { row.valid = false; row.error = "Provider output failed the application parser"; }
  } catch {
    row.latencyMs = Date.now() - started;
    row.valid = false; row.error = "Provider request failed; no application retry";
  }
  return row;
}
async function runBenchmark(original, candidate, selected, generate = null) {
  const rows = [];
  for (const [i, scenario] of selected.entries()) {
    const pair = { id: scenario.id, note: scenario.note, surface: scenario.surface,
      history: scenario.history };
    // Alternate order to reduce systematic warm-cache bias. One attempt per arm.
    const order = i % 2 ? ["B", "A"] : ["A", "B"];
    for (const arm of order) pair[arm] = await evaluate(arm === "A" ? original : candidate, scenario, generate);
    rows.push(pair);
  }
  return rows;
}
function summarize(rows, arm) {
  const all = rows.map(row => row[arm]);
  const total = values => values.reduce((a,b) => a+b,0);
  const completeSum = key => all.every(r => typeof r.usage?.[key] === "number")
    ? total(all.map(r => r.usage[key])) : null;
  return { promptChars: total(all.map(r => r.promptChars)),
    promptTokens: completeSum("promptTokens"), estimatedCostUsd: completeSum("estimatedCostUsd"),
    uncachedCostUsd: completeSum("uncachedCostUsd"), valid: all.filter(r => r.valid === true).length,
    invalid: all.filter(r => r.valid === false).length,
    failedChecks: all.flatMap(r => r.checks || []).filter(c => !c.pass).length };
}
const esc = v => String(v ?? "Not measured").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
function renderReport(rows, live) {
  const a = summarize(rows, "A"), b = summarize(rows, "B");
  const percent = (x,y) => typeof x === "number" && typeof y === "number" && x > 0 ? ((1-y/x)*100).toFixed(1)+"%" : "Not measured";
  const money = n => n == null ? "Not measured" : "$"+n.toFixed(5);
  const metrics = [
    ["Total system prompt characters",a.promptChars,b.promptChars,percent(a.promptChars,b.promptChars)],
    ["Provider input tokens (all calls)",a.promptTokens,b.promptTokens,percent(a.promptTokens,b.promptTokens)],
    ["Estimated cost (reported cache)",money(a.estimatedCostUsd),money(b.estimatedCostUsd),percent(a.estimatedCostUsd,b.estimatedCostUsd)],
    ["Estimated cost without caching",money(a.uncachedCostUsd),money(b.uncachedCostUsd),percent(a.uncachedCostUsd,b.uncachedCostUsd)],
    ["Valid parsed responses",live?a.valid:null,live?b.valid:null,""],
    ["Failed responses",live?a.invalid:null,live?b.invalid:null,""],
    ["Failed explicit checks",live?a.failedChecks:null,live?b.failedChecks:null,""]
  ];
  const cell = r => '<div><strong>'+esc(r.promptChars)+' prompt characters</strong><p>'+esc(r.error || r.reply || (live?"No customer-facing text":"Offline: no AI reply"))+'</p><pre>'+esc(JSON.stringify({actual:r.actual,checks:r.checks,usage:r.usage,latencyMs:r.latencyMs},null,2))+'</pre></div>';
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Neutro Sense A/B test</title><style>body{font:15px/1.5 system-ui;max-width:1200px;margin:32px auto;padding:0 18px;color:#213547}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d8e0e5;padding:10px;text-align:left;vertical-align:top}th{background:#edf3f5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}p{white-space:pre-wrap}section{margin:24px 0;border-top:1px solid #d8e0e5} .pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pair>div{min-width:0;background:#f5f7f8;padding:12px}@media(max-width:650px){.pair{grid-template-columns:1fr}}</style><h1>Neutro Sense prompt A/B test</h1><p>'+esc(live?"Live test: synthetic cases, direct Gemini requests, one application-level attempt per arm.":"Offline test: no provider calls, no actual tokens, cost or reply quality measured.")+'</p><p>Model: '+MODEL+' | '+rows.length+' scenarios. A = original; B = consolidated. Cost uses repository estimates, not an invoice. Missing usage makes the total unknown. This tests prompt generation and parser decisions, not message sending, media selection, sender routing or booking execution. Human review of both replies is required; automatic checks alone cannot establish quality.</p><table><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Reduction</th></tr></thead><tbody>'+metrics.map(m=>'<tr>'+m.map(v=>'<td>'+esc(v)+'</td>').join("")+'</tr>').join("")+'</tbody></table>'+rows.map(r=>'<section><h2>'+esc(r.id)+'</h2><p>'+esc(r.note)+'</p><p>'+esc(r.history.map(m=>m.role+": "+m.content).join("\n"))+'</p><div class="pair"><div><h3>A: original</h3>'+cell(r.A)+'</div><div><h3>B: consolidated</h3>'+cell(r.B)+'</div></div></section>').join("")+'</html>';
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: node scripts/neutro-ab.js [--live] [--limit=N] < config.json > report.html\nDefault: offline, all 30 cases. --live requires NEUTRO_AB_GEMINI_API_KEY; defaults to 10 cases, max 30.\n");
    return;
  }
  if (args.some(a=>a!=="--live" && !/^--limit=\d+$/.test(a))) throw Error("Unknown argument");
  const live = args.includes("--live");
  const limit = Number(args.find(a=>a.startsWith("--limit="))?.split("=")[1] || (live ? 10 : cases.length));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cases.length) throw Error("Invalid case limit");
  const original = JSON.parse(fs.readFileSync(0,"utf8"));
  const candidate = previewConsolidation(original);
  let generate = null;
  if (live) {
    const key = process.env.NEUTRO_AB_GEMINI_API_KEY;
    if (!key) throw Error("Set the separate NEUTRO_AB_GEMINI_API_KEY explicitly; no production-key fallback");
    const { GoogleGenAI } = require("@google/genai");
    const ai = new GoogleGenAI({ apiKey:key, httpOptions:{timeout:30000} });
    process.stderr.write("Live test: up to "+(limit*2)+" billable Gemini calls; no messages or database writes.\n");
    generate = request => ai.models.generateContent(request);
  }
  const rows = await runBenchmark(original,candidate,cases.slice(0,limit),generate);
  process.stdout.write(renderReport(rows,live));
}
if (require.main === module) main().catch(err=>{process.stderr.write("A/B test stopped: "+(err instanceof SyntaxError ? "invalid config JSON" : err.message)+"\n");process.exitCode=1;});
module.exports={requestFor,checksFor,usageOf,runBenchmark,summarize,renderReport};
