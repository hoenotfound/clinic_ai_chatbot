const gemini = require("./geminiService");
const claude = require("./claudeService");
const aiRoutingTelemetry = require("../db/aiRoutingTelemetryRepo");
const { parseAiReplyResult } = require("../utils/aiReplyResult");
const {
  classifyCandidateHealthFailure,
  credentialFingerprint,
  getCandidateCooldownUntilMs,
  getGeminiApiKeys,
  getRuntimeCandidateHealth,
  isRetryableAiError,
  recordCandidateHealth,
  runWithGeminiKeys,
} = require("./geminiKeyPool");

function getProviderPreference(env = process.env) {
  const value = String(env.AI_PROVIDER || "gemini").trim().toLowerCase();
  if (!new Set(["gemini", "claude"]).has(value)) {
    throw new Error(`Unknown AI_PROVIDER "${value}" - use "claude" or "gemini" in your .env`);
  }
  return value;
}

const DEFAULT_TIMEOUT_MS = 18 * 1000;
const DEFAULT_AI_GLOBAL_BUDGET_MS = 30 * 1000;
const DEFAULT_AI_FALLBACK_PROVIDER_RESERVE_MS = 10 * 1000;
const DEFAULT_RETRY_COUNT = 1;
const DEFAULT_GEMINI_GLOBAL_BUDGET_MS = 25 * 1000;
const DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS = 10 * 1000;
const DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS = 8 * 1000;
const DEFAULT_GEMINI_MIN_KEY_WINDOW_MS = 4 * 1000;
const DEFAULT_GEMINI_5XX_RETRY_COUNT = 1;
const DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS = 9 * 1000;
const DEFAULT_GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_ALTERNATE_MODEL = "gemini-3.5-flash-lite";
const runtimeGeminiModelHealth = new Map();

function recordRoutingEvent(event, options = {}) {
  if (options.privateSetupCheck) return;
  aiRoutingTelemetry.recordRoutingEvent(event).catch((err) => {
    console.warn("Could not save AI routing telemetry:", err?.message || err);
  });
}

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

async function runCandidate(
  candidate,
  messages,
  options,
  timeoutMs,
  retryCount,
  {
    globalBudgetMs = 0,
    clock = () => Date.now(),
  } = {}
) {
  let lastError = null;
  const startedAtMs = clock();

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const elapsedMs = Math.max(0, clock() - startedAtMs);
    const remainingBudgetMs = globalBudgetMs > 0
      ? globalBudgetMs - elapsedMs
      : Number.POSITIVE_INFINITY;

    if (remainingBudgetMs <= 0) {
      const err = new Error(`${candidate.label} exhausted its provider time budget.`);
      err.code = "AI_GLOBAL_BUDGET_EXCEEDED";
      throw err;
    }

    const attemptTimeoutMs = Number.isFinite(remainingBudgetMs)
      ? Math.max(1, Math.min(timeoutMs, remainingBudgetMs))
      : timeoutMs;

    try {
      const raw = await withTimeout(
        candidate.run(messages, options),
        attemptTimeoutMs,
        candidate.label
      );
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

function getGeminiModelUnavailableCooldownMs(env = process.env) {
  return positiveInt(
    env.GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS,
    DEFAULT_GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS,
    10 * 60 * 1000
  );
}

function geminiModelHealthKey(model, env = process.env) {
  const poolFingerprint = getGeminiApiKeys(env)
    .map(credentialFingerprint)
    .join(",") || "no_keys";
  return `${String(model || "unknown")}:${poolFingerprint}`;
}

function modelCooldownUntilMs(model, env = process.env) {
  const value = runtimeGeminiModelHealth.get(geminiModelHealthKey(model, env))?.cooldownUntil;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function markGeminiModelUnavailable(model, env = process.env, nowMs = Date.now()) {
  const cooldownMs = getGeminiModelUnavailableCooldownMs(env);
  const healthKey = geminiModelHealthKey(model, env);
  if (cooldownMs <= 0) {
    runtimeGeminiModelHealth.delete(healthKey);
    return null;
  }
  const row = {
    model,
    status: "unavailable",
    lastUnavailableAt: new Date(nowMs),
    cooldownUntil: new Date(nowMs + cooldownMs),
  };
  runtimeGeminiModelHealth.set(healthKey, row);
  return { ...row };
}

function clearGeminiModelCooldown(model, env = process.env) {
  runtimeGeminiModelHealth.delete(geminiModelHealthKey(model, env));
}

function getRuntimeGeminiModelHealth(env = process.env, nowMs = Date.now()) {
  return getGeminiReplyModels(env).map((model) => {
    const row = runtimeGeminiModelHealth.get(geminiModelHealthKey(model, env));
    const cooldownUntil = row?.cooldownUntil || null;
    const coolingDown = Boolean(cooldownUntil && new Date(cooldownUntil).getTime() > nowMs);
    return {
      model,
      status: coolingDown ? "cooling_down" : "available",
      lastUnavailableAt: row?.lastUnavailableAt || null,
      cooldownUntil: coolingDown ? cooldownUntil : null,
    };
  });
}

function resetGeminiModelHealth() {
  runtimeGeminiModelHealth.clear();
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
    candidate.reportOutcome = (outcome) => recordCandidateHealth(candidate, outcome, { env });
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
        candidate.reportOutcome = (outcome) => recordCandidateHealth(candidate, outcome, { env });
        return [candidate];
      })()
    : [];

  return getProviderPreference(env) === "claude"
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

function getAiReplyPolicy(env = process.env) {
  return {
    globalBudgetMs: positiveInt(
      env.AI_REPLY_GLOBAL_BUDGET_MS,
      DEFAULT_AI_GLOBAL_BUDGET_MS,
      60_000
    ),
    fallbackProviderReserveMs: positiveInt(
      env.AI_REPLY_FALLBACK_PROVIDER_RESERVE_MS,
      DEFAULT_AI_FALLBACK_PROVIDER_RESERVE_MS,
      30_000
    ),
  };
}

function computeProviderBudgetMs(remainingBudgetMs, hasLaterProvider, reserveMs) {
  if (!(remainingBudgetMs > 0) || !hasLaterProvider) return Math.max(0, remainingBudgetMs);
  const boundedReserve = Math.min(
    Math.max(0, reserveMs || 0),
    Math.max(0, remainingBudgetMs - 1)
  );
  return Math.max(1, remainingBudgetMs - boundedReserve);
}

function geminiEnvForProviderBudget(env, providerBudgetMs) {
  const existing = getGeminiReplyPolicy(env);
  const globalBudgetMs = Math.max(
    1,
    Math.min(existing.globalBudgetMs, Math.max(1, providerBudgetMs))
  );
  const fallbackModelReserveMs = Math.min(
    existing.fallbackModelReserveMs,
    Math.max(0, Math.floor(globalBudgetMs / 2))
  );
  return {
    ...env,
    GEMINI_REPLY_GLOBAL_BUDGET_MS: String(globalBudgetMs),
    GEMINI_REPLY_FALLBACK_MODEL_RESERVE_MS: String(fallbackModelReserveMs),
  };
}


function getEffectiveGeminiMinKeyWindowMs(env, policy) {
  const keyCount = getGeminiApiKeys(env).length;
  if (keyCount <= 0 || !(policy?.globalBudgetMs > 0)) {
    return policy?.minRemainingKeyWindowMs || 0;
  }

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

function createGeminiModelsCoolingError(models, env, nowMs) {
  const nextRetryMs = Math.min(
    ...models
      .map((model) => modelCooldownUntilMs(model, env))
      .filter((value) => value > nowMs)
  );
  const err = new Error("All configured Gemini reply models are temporarily cooling down after model-capacity failures.");
  err.code = "ALL_GEMINI_MODELS_COOLING_DOWN";
  err.nextRetryAt = Number.isFinite(nextRetryMs) ? new Date(nextRetryMs) : null;
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
  const configuredModels = getGeminiReplyModels(env);
  const startedAtMs = clock();
  const models = configuredModels.filter(
    (model) => modelCooldownUntilMs(model, env) <= startedAtMs
  );
  const failures = [];

  if (!models.length) {
    throw createGeminiModelsCoolingError(configuredModels, env, startedAtMs);
  }

  if (models[0] !== configuredModels[0]) {
    recordRoutingEvent({
      eventType: "gemini_model_fallback",
      provider: "gemini",
      model: models[0],
    }, options);
  }

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
      const reply = await runWithGeminiKeys(
        (apiKey) => runGeminiModelAttempt(messages, options, apiKey, model, {
          // A provider-level 503 says the model is unavailable, not the key.
          // When another model is ready, switch immediately rather than spend
          // a second quota-counting request on the same overloaded model.
          overloadRetryCount: hasLaterModel ? 0 : policy.retryCount,
          sleepFn,
          randomFn,
        }),
        {
          env,
          healthScope: `model:${model}`,
          retryCount: policy.retryCount,
          globalBudgetMs: modelBudgetMs,
          preferredTimeoutMs: policy.preferredTimeoutMs,
          fallbackTimeoutMs: policy.fallbackTimeoutMs,
          minRemainingKeyWindowMs: effectiveMinKeyWindowMs,
          smartRetry: true,
          stopKeyRotationOnTimeout: hasLaterModel,
          smartRetryDelayMinMs: 500,
          smartRetryDelayMaxMs: 1000,
          clock,
          sleepFn,
          randomFn,
        }
      );
      clearGeminiModelCooldown(model, env);
      return reply;
    } catch (err) {
      failures.push({ model, error: err });
      if (err?.code === "GEMINI_MODEL_UNAVAILABLE") {
        const health = markGeminiModelUnavailable(model, env, clock());
        if (health?.cooldownUntil) {
          console.warn(
            `Gemini model ${model} is cooling down until ${health.cooldownUntil.toISOString()} after a capacity failure.`
          );
        }
      }
      if (hasLaterModel) {
        recordRoutingEvent({
          eventType: "gemini_model_fallback",
          provider: "gemini",
          model: models[modelIndex + 1],
        }, options);
        const transition = err?.code === "AI_TIMEOUT" ? "timed out" : "failed";
        console.warn(
          `Gemini model ${model} ${transition}; switching to ${models[modelIndex + 1]} within the same global budget:`,
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

async function runClaudeReply(
  messages,
  options,
  timeoutMs,
  retryCount,
  env = process.env,
  {
    globalBudgetMs = 0,
    clock = () => Date.now(),
  } = {}
) {
  const candidate = buildCandidates(env).find((item) => item.provider === "claude");
  if (!candidate) {
    const err = new Error("ANTHROPIC_API_KEY is not configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw err;
  }

  const cooldownUntilMs = getCandidateCooldownUntilMs(candidate);
  if (cooldownUntilMs > clock()) {
    const err = new Error("Claude is temporarily cooling down after a recent provider failure.");
    err.code = "AI_CANDIDATE_COOLING_DOWN";
    err.nextRetryAt = new Date(cooldownUntilMs);
    throw err;
  }

  return runCandidate(
    candidate,
    messages,
    options,
    timeoutMs,
    retryCount,
    { globalBudgetMs, clock }
  );
}

async function getReplyWithEnv(
  messages,
  optionsOrFirstMessage = false,
  env = process.env,
  {
    clock = () => Date.now(),
  } = {}
) {
  const options = typeof optionsOrFirstMessage === "boolean"
    ? {
        isFirstMessage: optionsOrFirstMessage,
        channel: "whatsapp",
        privateSetupCheck: false,
        surface: "conversation",
        publicReplyEnabled: true,
        privateReplyEnabled: true,
      }
    : {
        isFirstMessage: Boolean(optionsOrFirstMessage?.isFirstMessage),
        channel: optionsOrFirstMessage?.channel || "whatsapp",
        privateSetupCheck: Boolean(optionsOrFirstMessage?.privateSetupCheck),
        surface: optionsOrFirstMessage?.surface || "conversation",
        publicReplyEnabled: optionsOrFirstMessage?.publicReplyEnabled !== false,
        privateReplyEnabled: optionsOrFirstMessage?.privateReplyEnabled !== false,
      };

  const timeoutMs = positiveInt(env.AI_REPLY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const retryCount = positiveInt(env.AI_REPLY_RETRY_COUNT, DEFAULT_RETRY_COUNT, 3);
  const hasGemini = getGeminiApiKeys(env).length > 0;
  const hasClaude = Boolean(env.ANTHROPIC_API_KEY);
  const preferredProvider = getProviderPreference(env);
  const policy = getAiReplyPolicy(env);
  const startedAtMs = clock();

  if (!hasGemini && !hasClaude) {
    const err = new Error("No AI provider API key is configured.");
    err.code = "AI_PROVIDER_NOT_CONFIGURED";
    recordRoutingEvent({ eventType: "ai_failure" }, options);
    throw err;
  }

  const providerOrder = preferredProvider === "claude"
    ? ["claude", "gemini"]
    : ["gemini", "claude"];
  const configuredProviders = providerOrder.filter((candidateProvider) => (
    candidateProvider === "gemini" ? hasGemini : hasClaude
  ));
  const failures = [];

  for (let providerIndex = 0; providerIndex < configuredProviders.length; providerIndex += 1) {
    const candidateProvider = configuredProviders[providerIndex];
    const elapsedMs = Math.max(0, clock() - startedAtMs);
    const remainingBudgetMs = policy.globalBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) break;

    const hasLaterProvider = providerIndex < configuredProviders.length - 1;
    const providerBudgetMs = computeProviderBudgetMs(
      remainingBudgetMs,
      hasLaterProvider,
      policy.fallbackProviderReserveMs
    );

    try {
      if (candidateProvider === "gemini") {
        return await runGeminiReply(
          messages,
          options,
          geminiEnvForProviderBudget(env, providerBudgetMs),
          { clock }
        );
      }

      const reply = await runClaudeReply(
        messages,
        options,
        timeoutMs,
        retryCount,
        env,
        { globalBudgetMs: providerBudgetMs, clock }
      );
      if (preferredProvider === "gemini" && failures.some((item) => item.provider === "gemini")) {
        recordRoutingEvent({
          eventType: "claude_fallback",
          provider: "claude",
        }, options);
      }
      return reply;
    } catch (err) {
      failures.push({
        provider: candidateProvider,
        code: err?.code || null,
        message: String(err?.message || err).slice(0, 300),
      });
    }
  }

  recordRoutingEvent({ eventType: "ai_failure" }, options);
  const err = new Error(
    `All AI reply attempts failed. ${failures
      .map((item) => `${item.provider}: ${item.message}`)
      .join(" | ")}`
  );
  err.code = policy.globalBudgetMs > 0 && clock() - startedAtMs >= policy.globalBudgetMs
    ? "AI_GLOBAL_BUDGET_EXCEEDED"
    : "ALL_AI_PROVIDERS_FAILED";
  err.failures = failures;
  throw err;
}

async function getReply(messages, optionsOrFirstMessage = false) {
  return getReplyWithEnv(messages, optionsOrFirstMessage, process.env);
}

console.log(`AI provider preference: ${getProviderPreference(process.env)}`);

module.exports = {
  DEFAULT_AI_FALLBACK_PROVIDER_RESERVE_MS,
  DEFAULT_AI_GLOBAL_BUDGET_MS,
  DEFAULT_GEMINI_ALTERNATE_MODEL,
  DEFAULT_GEMINI_FALLBACK_MODEL_RESERVE_MS,
  DEFAULT_GEMINI_FALLBACK_TIMEOUT_MS,
  DEFAULT_GEMINI_GLOBAL_BUDGET_MS,
  DEFAULT_GEMINI_MIN_KEY_WINDOW_MS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_UNAVAILABLE_COOLDOWN_MS,
  DEFAULT_GEMINI_PREFERRED_TIMEOUT_MS,
  buildCandidates,
  classifyCandidateHealthFailure,
  computeProviderBudgetMs,
  clearGeminiModelCooldown,
  computeGeminiModelBudgetMs,
  credentialFingerprint,
  geminiModelHealthKey,
  getAiReplyPolicy,
  getCandidateHealthDescriptors,
  getEffectiveGeminiMinKeyWindowMs,
  getGeminiApiKeys,
  getGeminiModelUnavailableCooldownMs,
  getGeminiReplyModels,
  getGeminiReplyPolicy,
  getProviderPreference,
  getRuntimeCandidateHealth,
  getRuntimeGeminiModelHealth,
  getReply,
  getReplyWithEnv,
  isGeminiModelUnavailableError,
  isRetryableAiError,
  markGeminiModelUnavailable,
  resetGeminiModelHealth,
  runCandidate,
  runClaudeReply,
  runGeminiModelAttempt,
  runGeminiReply,
};
