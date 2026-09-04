const gemini = require("./geminiService");
const claude = require("./claudeService");
const { parseAiReplyResult } = require("../utils/aiReplyResult");
const {
  classifyCandidateHealthFailure,
  credentialFingerprint,
  getGeminiApiKeys,
  getRuntimeCandidateHealth,
  isRetryableAiError,
  recordCandidateHealth,
  runWithGeminiKeys,
} = require("./geminiKeyPool");

const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
if (!new Set(["gemini", "claude"]).has(provider)) {
  throw new Error(`Unknown AI_PROVIDER "${provider}" - use "claude" or "gemini" in your .env`);
}

const DEFAULT_TIMEOUT_MS = 18 * 1000;
const DEFAULT_RETRY_COUNT = 1;

function positiveInt(value, fallback, max = 60_000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
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
      // malformed structured output gets the same bounded retry as transient
      // provider failures.
      parseAiReplyResult(raw);
      candidate.reportOutcome?.({ status: "ready", failureKind: null });
      return raw;
    } catch (err) {
      lastError = err;
      candidate.reportOutcome?.(classifyCandidateHealthFailure(err));
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
  const geminiCandidates = getGeminiApiKeys(env).map((apiKey, index) => {
    const candidate = {
      label: `Gemini key ${index + 1}`,
      provider: "gemini",
      healthKey: `gemini_${credentialFingerprint(apiKey)}`,
      run: (messages, options) => gemini.getReply(messages, options, apiKey),
    };
    candidate.reportOutcome = (outcome) => recordCandidateHealth(candidate, outcome);
    return candidate;
  });

  const claudeCandidates = env.ANTHROPIC_API_KEY
    ? (() => {
        const candidate = {
          label: "Claude fallback",
          provider: "claude",
          healthKey: `claude_${credentialFingerprint(env.ANTHROPIC_API_KEY)}`,
          run: (messages, options) => claude.getReply(messages, options, env.ANTHROPIC_API_KEY),
        };
        candidate.reportOutcome = (outcome) => recordCandidateHealth(candidate, outcome);
        return [candidate];
      })()
    : [];

  return provider === "claude"
    ? [...claudeCandidates, ...geminiCandidates]
    : [...geminiCandidates, ...claudeCandidates];
}

function getCandidateHealthDescriptors(env = process.env) {
  return buildCandidates(env).map(({ healthKey, label, provider: candidateProvider }) => ({
    healthKey,
    label,
    provider: candidateProvider,
  }));
}

async function runGeminiReply(messages, options, timeoutMs, retryCount) {
  return runWithGeminiKeys(
    async (apiKey) => {
      const raw = await gemini.getReply(messages, options, apiKey);
      parseAiReplyResult(raw);
      return raw;
    },
    {
      timeoutMs,
      retryCount,
    }
  );
}

async function runClaudeReply(messages, options, timeoutMs, retryCount) {
  const candidate = buildCandidates().find((item) => item.provider === "claude");
  if (!candidate) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }
  return runCandidate(candidate, messages, options, timeoutMs, retryCount);
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
  const hasGemini = getGeminiApiKeys().length > 0;
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);

  if (!hasGemini && !hasClaude) {
    const err = new Error("No AI provider API key is configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const providerOrder = provider === "claude"
    ? ["claude", "gemini"]
    : ["gemini", "claude"];
  const failures = [];

  for (const candidateProvider of providerOrder) {
    if (candidateProvider === "gemini" && !hasGemini) continue;
    if (candidateProvider === "claude" && !hasClaude) continue;

    try {
      if (candidateProvider === "gemini") {
        return await runGeminiReply(messages, options, timeoutMs, retryCount);
      }
      return await runClaudeReply(messages, options, timeoutMs, retryCount);
    } catch (err) {
      failures.push(`${candidateProvider}: ${err?.message || err}`);
    }
  }

  const err = new Error(`All AI reply attempts failed. ${failures.join(" | ")}`);
  err.code = "ALL_AI_PROVIDERS_FAILED";
  throw err;
}

console.log(`AI provider preference: ${provider}`);

module.exports = {
  buildCandidates,
  classifyCandidateHealthFailure,
  credentialFingerprint,
  getCandidateHealthDescriptors,
  getGeminiApiKeys,
  getRuntimeCandidateHealth,
  getReply,
  isRetryableAiError,
  runCandidate,
  runGeminiReply,
};