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
const DEFAULT_GEMINI_GLOBAL_BUDGET_MS = 25 * 1000;
const DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS = 8 * 1000;
const DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS = 5 * 1000;
const DEFAULT_GEMINI_MIN_KEY_WINDOW_MS = 4 * 1000;
const DEFAULT_GEMINI_5XX_RETRY_COUNT = 1;
const DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS = 8 * 1000;
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_ALTERNATE_MODEL = "gemini-3.7-flash";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function getGeminiReplyModels(env = process.env) {
  const primary = String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const hasExplicitFallback = Object.prototype.hasOwnProperty.call(env, "GEMINI_FALLBACK_MODEL");
  const fallback = hasExplicitFallback
    ? String(env.GEMINI_FALLBACK_MODEL || "").trim()
    : primary === DEFAULT_GEMINI_MODEL
      ? DEFAULT_GEMINI_ALTERNATE_MODEL
      : DEFAULT_GEMINI_MODEL;

  return [...new Set([primary, fallback].filter(Boolean))];
}

function getNumericErrorStatus(err) {
  for (const value of [err?.status, err?.statusCode, err?.response?.status]) {
    if (value == null || value === "") continue;
    const status = Number(value);
    if (Number.isInteger(status)) return status;
  }
  return null;
}

function isGeminiModelUnavailableError(err) {
  const status = getNumericErrorStatus(err);
  const providerStatus = String(
    err?.error?.status
      || err?.response?.data?.error?.status
      || err?.response?.body?.error?.status
      || err?.details?.error?.status
      || ""
  ).trim().toUpperCase();
  const message = String(err?.message || "").toLowerCase();

  return status === 503
    || providerStatus === "UNAVAILABLE"
    || /currently experiencing high demand|model[^.]{0,80}(?:high demand|overload|unavailable)/.test(message)
    || (/\b503\b/.test(message) && /high demand|overload|unavailable|service unavailable/.test(message));
}

function createGeminiModelUnavailableError(model, cause) {
  const err = new Error(`Gemini model ${model} is temporarily unavailable.`);
  err.code = "GEMINI_MODEL_UNAVAILABLE";
  // The key-pool must not rotate/cool healthy credentials for a provider/model
  // capacity problem. aiService will switch to the next Gemini model instead.
  err.stopGeminiKeyRotation = true;
  err.model = model;
  err.cause = cause;
  return err;
}

async function runGeminiModelAttempt(
  messages,
  options,
  apiKey,
  model,
  {
    overloadRetryCount = 1,
    sleepFn = sleep,
    randomFn = Math.random,
  } = {}
) {
  const boundedRetryCount = Math.max(0, Math.min(Number(overloadRetryCount) || 0, 1));

  for (let attempt = 0; attempt <= boundedRetryCount; attempt += 1) {
    try {
      const raw = await gemini.getReply(messages, options, apiKey, model);
      parseAiReplyResult(raw);
      return raw;
    } catch (err) {
      if (!isGeminiModelUnavailableError(err)) throw err;
      if (attempt >= boundedRetryCount) {
        throw createGeminiModelUnavailableError(model, err);
      }

      // A single short jittered retry is enough for a brief capacity spike. If
      // it is still unavailable, switching models is more useful than trying
      // the same overloaded model with every API key.
      const delayMs = Math.round(500 + 500 * Math.max(0, Math.min(1, randomFn())));
      console.warn(`Gemini model ${model} is unavailable; retrying once before model fallback.`);
      await sleepFn(delayMs);
    }
  }

  throw createGeminiModelUnavailableError(model, null);
}

function buildCandidates(env = process.env) {
  const primaryModel = getGeminiReplyModels(env)[0];
  const geminiCandidates = getGeminiApiKeys(env).map((apiKey, index) => {
    const candidate = {
      label: `Gemini key ${index + 1}`,
      provider: "gemini",
      healthKey: `gemini_${credentialFingerprint(apiKey)}`,
      run: (messages, options) => gemini.getReply(messages, options, apiKey, primaryModel),
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

function getGeminiReplyPolicy(env = process.env) {
  return {
    globalBudgetMs: positiveInt(
      env.GEMINI_REPLY_GLOBAL_BUDGET_MS,
      DEFAULT_GEMINI_GLOBAL_BUDGET_MS,
      60_000
    ),
    preferredTimeoutMs: positiveInt(
      env.GEMINI_REPLY_PREFERRED_TIMEOUT_MS,
      DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS,
      30_000
    ),
    fallbackTimeoutMs: positiveInt(
      env.GEMINI_REPLY_FALLBACK_TIMEOUT_MS,
      DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS,
      30_000
    ),
    minRemainingKeyWindowMs: positiveInt(
      env.GEMINI_REPLY_MIN_KEY_WINDOW_MS,
      DEFAULT_GEMINI_MIN_KEY_WINDOW_MS,
      15_000
    ),
    fallbackModelReserveMs: positiveInt(
      env.GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS,
      DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS,
      30_000
    ),
    retryCount: positiveInt(
      env.GEMINI_REPLY_5XX_RETRY_COUNT,
      DEFAULT_GEMINI_5XX_RETRY_COUNT,
      1
    ),
  };
}

function getEffectiveGeminiMinKeyWindowMs(env, policy) {
  const keyCount = getGeminiApiKeys(env).length;
  if (keyCount <= 0 || !(policy?.globalBudgetMs > 0)) {
    return policy?.minRemainingKeyWindowMs || 0;
  }

  // The configured reserve is ideal for normal-sized pools (for example five
  // keys: 25s / 5 still leaves the requested 4s reserve). If a much larger
  // GEMINI_API_KEYS list is configured, scale the reserve to a fair share of
  // the same global budget instead of starving early keys with ~1ms attempts.
  const fairShareMs = Math.max(1, Math.floor(policy.globalBudgetMs / keyCount));
  return Math.min(policy.minRemainingKeyWindowMs, fairShareMs);
}

function computeGeminiModelBudgetMs(remainingBudgetMs, hasLaterModel, reserveMs) {
  if (!(remainingBudgetMs > 0) || !hasLaterModel) return Math.max(0, remainingBudgetMs);
  const boundedReserve = Math.min(
    Math.max(0, reserveMs || 0),
    Math.max(0, remainingBudgetMs - 1)
  );
  return Math.max(1, remainingBudgetMs - boundedReserve);
}

function createGeminiModelsFailedError(failures) {
  const err = new Error(
    `All Gemini reply models failed. ${failures
      .map(({ model, error }) => `${model}: ${error?.message || error}`)
      .join(" | ")}`
  );
  err.code = "ALL_GEMINI_MODELS_FAILED";
  err.failures = failures.map(({ model, error }) => ({
    model,
    code: error?.code || null,
    message: String(error?.message || "Gemini request failed.").slice(0, 240),
  }));
  return err;
}

async function runGeminiReply(
  messages,
  options,
  env = process.env,
  {
    clock = () => Date.now(),
    sleepFn = sleep,
    randomFn = Math.random,
  } = {}
) {
  const policy = getGeminiReplyPolicy(env);
  const models = getGeminiReplyModels(env);
  const startedAtMs = clock();
  const failures = [];

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const elapsedMs = Math.max(0, clock() - startedAtMs);
    const remainingBudgetMs = policy.globalBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) break;

    const hasLaterModel = modelIndex < models.length - 1;
    const modelBudgetMs = computeGeminiModelBudgetMs(
      remainingBudgetMs,
      hasLaterModel,
      policy.fallbackModelReserveMs
    );
    const modelPolicy = { ...policy, globalBudgetMs: modelBudgetMs };
    const effectiveMinKeyWindowMs = getEffectiveGeminiMinKeyWindowMs(env, modelPolicy);

    try {
      return await runWithGeminiKeys(
        (apiKey) => runGeminiModelAttempt(messages, options, apiKey, model, {
          overloadRetryCount: policy.retryCount,
          sleepFn,
          randomFn,
        }),
        {
          env,
          retryCount: policy.retryCount,
          globalBudgetMs: modelBudgetMs,
          preferredTimeoutMs: policy.preferredTimeoutMs,
          fallbackTimeoutMs: policy.fallbackTimeoutMs,
          minRemainingKeyWindowMs: effectiveMinKeyWindowMs,
          smartRetry: true,
          smartRetryDelayMinMs: 500,
          smartRetryDelayMaxMs: 1000,
          clock,
          sleepFn,
          randomFn,
        }
      );
    } catch (err) {
      failures.push({ model, error: err });
      if (hasLaterModel) {
        console.warn(
          `Gemini model ${model} failed; switching to ${models[modelIndex + 1]} within the same global budget:`,
          err?.message || err
        );
      }
    }
  }

  if (!failures.length) {
    const err = new Error("Gemini reply time budget was exhausted before a model could be attempted.");
    err.code = "GEMINI_GLOBAL_BUDGET_EXCEEDED";
    throw err;
  }
  throw createGeminiModelsFailedError(failures);
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

  // AI_REPLY_TIMEOUT_MS / AI_REPLY_RETRY_COUNT remain the fallback-provider
  // controls. Gemini chat replies use the smarter global-budget policy above.
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
        return await runGeminiReply(messages, options);
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
  DEFAULT_GEMINI_ALTERNATE_MODEL,
  DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS,
  DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS,
  DEFAULT_GEMINI_GLOBAL_BUDGET_MS,
  DEFAULT_GEMINI_MIN_KEY_WINDOW_MS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS,
  buildCandidates,
  classifyCandidateHealthFailure,
  computeGeminiModelBudgetMs,
  credentialFingerprint,
  getCandidateHealthDescriptors,
  getEffectiveGeminiMinKeyWindowMs,
  getGeminiApiKeys,
  getGeminiReplyModels,
  getGeminiReplyPolicy,
  getRuntimeCandidateHealth,
  getReply,
  isGeminiModelUnavailableError,
  isRetryableAiError,
  runCandidate,
  runGeminiModelAttempt,
  runGeminiReply,
};
