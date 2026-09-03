const crypto = require("crypto");
const gemini = require("./geminiService");
const claude = require("./claudeService");
const { parseAiReplyResult } = require("../utils/aiReplyResult");
const setupStatusRepo = require("../db/setupStatusRepo");

const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
if (!new Set(["gemini", "claude"]).has(provider)) {
  throw new Error(`Unknown AI_PROVIDER "${provider}" — use "claude" or "gemini" in your .env`);
}

const DEFAULT_TIMEOUT_MS = 18 * 1000;
const DEFAULT_RETRY_COUNT = 1;
const runtimeCandidateHealth = new Map();

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

function credentialFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 24);
}

function classifyCandidateHealthFailure(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();

  if (status === 429 || /rate limit|quota|resource exhausted|too many requests/.test(message)) {
    return { status: "rate_limited", failureKind: "rate_limit" };
  }
  if ([401, 403].includes(status) || /api.?key.*invalid|invalid.*api.?key|unauthorized|permission denied/.test(message)) {
    return { status: "invalid", failureKind: "authentication" };
  }
  if (["INVALID_AI_RESPONSE", "EMPTY_AI_RESPONSE"].includes(code)) {
    return { status: "failed", failureKind: "invalid_response" };
  }
  if (code === "AI_TIMEOUT" || /timeout|timed out/.test(message)) {
    return { status: "unavailable", failureKind: "timeout" };
  }
  if (isRetryableAiError(err)) {
    return { status: "unavailable", failureKind: "temporary_failure" };
  }
  return { status: "failed", failureKind: "provider_error" };
}

function recordCandidateHealth(candidate, outcome) {
  if (!candidate?.healthKey || !candidate?.provider || !outcome?.status) return;
  const at = new Date();
  const previous = runtimeCandidateHealth.get(candidate.healthKey) || {};
  const failed = outcome.status !== "ready";
  runtimeCandidateHealth.set(candidate.healthKey, {
    candidate_key: candidate.healthKey,
    provider: candidate.provider,
    last_status: outcome.status,
    last_failure_kind: failed
      ? outcome.failureKind || "provider_error"
      : previous.last_failure_kind || null,
    last_attempt_at: at,
    last_success_at: outcome.status === "ready" ? at : previous.last_success_at || null,
    last_failure_at: failed ? at : previous.last_failure_at || null,
    last_rate_limited_at: outcome.status === "rate_limited"
      ? at
      : previous.last_rate_limited_at || null,
  });

  setupStatusRepo.recordAiCandidateOutcome({
    candidateKey: candidate.healthKey,
    provider: candidate.provider,
    status: outcome.status,
    failureKind: outcome.failureKind || null,
    at,
  }).catch((err) => {
    console.warn(`Could not save ${candidate.label} health:`, err?.message || err);
  });
}

function getRuntimeCandidateHealth() {
  return [...runtimeCandidateHealth.values()].map((row) => ({ ...row }));
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
  return buildCandidates(env).map(({ healthKey, label, provider }) => ({
    healthKey,
    label,
    provider,
  }));
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
  classifyCandidateHealthFailure,
  credentialFingerprint,
  getCandidateHealthDescriptors,
  getGeminiApiKeys,
  getRuntimeCandidateHealth,
  getReply,
  isRetryableAiError,
  runCandidate,
};
