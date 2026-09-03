const gemini = require("./geminiService");
const claude = require("./claudeService");
const { parseAiReplyResult } = require("../utils/aiReplyResult");

const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
if (!new Set(["gemini", "claude"]).has(provider)) {
  throw new Error(`Unknown AI_PROVIDER "${provider}" — use "claude" or "gemini" in your .env`);
}

const DEFAULT_TIMEOUT_MS = 18 * 1000;
const DEFAULT_RETRY_COUNT = 1;

function positiveInt(value, fallback, max = 60_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function getGeminiApiKeys(env = process.env) {
  const candidates = [];
  if (env.GEMINI_API_KEYS) {
    candidates.push(...String(env.GEMINI_API_KEYS).split(/[\n,;]/));
  }
  candidates.push(
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
    env.GEMINI_API_KEY_5
  );
  return [...new Set(candidates.map((value) => String(value || "").trim()).filter(Boolean))];
}

function isRetryableAiError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;

  const code = String(err?.code || "").toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EAI_AGAIN",
      "AI_TIMEOUT",
      "INVALID_AI_RESPONSE",
      "EMPTY_AI_RESPONSE",
    ].includes(code)
  ) {
    return true;
  }

  const message = String(err?.message || "").toLowerCase();
  return /timeout|timed out|rate limit|quota|resource exhausted|overload|temporar|unavailable|try again|429|500|502|503|504/.test(message);
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${timeoutMs}ms.`);
        err.code = "AI_TIMEOUT";
        reject(err);
      }, timeoutMs);
    }),
  ]);
}

async function runCandidate(candidate, messages, options, timeoutMs, retryCount) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const raw = await withTimeout(
        candidate.run(messages, options),
        timeoutMs,
        candidate.label
      );
      // Validate the provider response before calling it a success. Empty or
      // malformed structured output is usually a one-off model formatting
      // failure, so it gets the same bounded retry as transient provider
      // failures before rotating to the next key/provider.
      parseAiReplyResult(raw);
      return raw;
    } catch (err) {
      lastError = err;
      const retry = attempt < retryCount && isRetryableAiError(err);
      console.warn(
        `${candidate.label} attempt ${attempt + 1} failed${retry ? "; retrying" : ""}:`,
        err?.message || err
      );
      if (!retry) break;
    }
  }
  throw lastError || new Error(`${candidate.label} failed.`);
}

function buildCandidates(env = process.env) {
  const geminiCandidates = getGeminiApiKeys(env).map((apiKey, index) => ({
    label: `Gemini key ${index + 1}`,
    run: (messages, options) => gemini.getReply(messages, options, apiKey),
  }));

  const claudeCandidates = env.ANTHROPIC_API_KEY
    ? [{
        label: "Claude fallback",
        run: (messages, options) => claude.getReply(messages, options, env.ANTHROPIC_API_KEY),
      }]
    : [];

  return provider === "claude"
    ? [...claudeCandidates, ...geminiCandidates]
    : [...geminiCandidates, ...claudeCandidates];
}

async function getReply(messages, optionsOrFirstMessage = false) {
  const options = typeof optionsOrFirstMessage === "boolean"
    ? { isFirstMessage: optionsOrFirstMessage, channel: "whatsapp" }
    : {
        isFirstMessage: Boolean(optionsOrFirstMessage?.isFirstMessage),
        channel: optionsOrFirstMessage?.channel || "whatsapp",
      };

  const timeoutMs = positiveInt(process.env.AI_REPLY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const retryCount = positiveInt(process.env.AI_REPLY_RETRY_COUNT, DEFAULT_RETRY_COUNT, 3);
  const candidates = buildCandidates();

  if (!candidates.length) {
    const err = new Error("No AI provider API key is configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const failures = [];
  for (const candidate of candidates) {
    try {
      return await runCandidate(candidate, messages, options, timeoutMs, retryCount);
    } catch (err) {
      failures.push(`${candidate.label}: ${err?.message || err}`);
    }
  }

  const err = new Error(`All AI reply attempts failed. ${failures.join(" | ")}`);
  err.code = "ALL_AI_PROVIDERS_FAILED";
  throw err;
}

console.log(`AI provider preference: ${provider}`);

module.exports = {
  buildCandidates,
  getGeminiApiKeys,
  getReply,
  isRetryableAiError,
  runCandidate,
};