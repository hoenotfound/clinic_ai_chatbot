// Standard paid Gemini Developer API estimates, USD per million tokens.
// These are estimates, never provider invoices. Update when Google changes rates.
// https://ai.google.dev/gemini-api/docs/pricing
const PRICES = Object.freeze({
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cache: 0.075, promotional: true },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cache: 0.075, promotional: true },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cache: 0.075, promotional: true },
  "gemini-3.5-flash": { input: 1.50, output: 9.00, cache: 0.15 },
  "gemini-3.5-flash-lite": { input: 0.30, output: 2.50, cache: 0.03 },
  "gemini-3.5-transcribe": { input: 2.00, output: 12.00, cache: null },
});

function nonNegativeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function getRate(provider, model, at = new Date()) {
  if (provider !== "gemini") return null;
  const rate = PRICES[String(model || "").trim()];
  if (!rate) return null;
  // Google states that the 3.6/3.7/3.8 Flash introductory rates end in 2026.
  if (rate.promotional && new Date(at).getTime() >= Date.UTC(2027, 0, 1)) {
    return { input: 1.50, output: 7.50, cache: 0.15 };
  }
  return rate;
}

function estimateAiUsage(event, at = new Date()) {
  const prompt = nonNegativeCount(event?.promptTokens);
  const output = nonNegativeCount(event?.outputTokens);
  const thinking = nonNegativeCount(event?.thinkingTokens);
  const cached = Math.min(prompt, nonNegativeCount(event?.cachedTokens));
  const hasUsage = prompt + output + thinking > 0;
  if (!hasUsage) {
    // A timeout may have been charged by the provider even with no usage metadata.
    return { costUsd: null, pricingStatus: "usage_unknown" };
  }
  const rate = getRate(event?.provider, event?.model, at);
  if (!rate) return { costUsd: null, pricingStatus: "unpriced_model" };
  // Do not infer cached tokens from prefix reuse. Bill only explicitly reported hits.
  const price = ((prompt - cached) * rate.input +
    cached * (rate.cache ?? rate.input) +
    (output + thinking) * rate.output) / 1_000_000;
  return { costUsd: Number(price.toFixed(10)), pricingStatus: "estimated" };
}

module.exports = { estimateAiUsage, getRate, nonNegativeCount };
