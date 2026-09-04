const crypto = require("crypto");
const setupStatusRepo = require("../db/setupStatusRepo");

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 1000;
const DEFAULT_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 30 * 1000;
const DEFAULT_INVALID_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const runtimeCandidateHealth = new Map();
let activeGeminiHealthKey = null;

function positiveInt(value, fallback, max = MAX_COOLDOWN_MS) {
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

function credentialFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, 24);
}

function getErrorStatus(err) {
  const candidates = [
    err?.status,
    err?.statusCode,
    err?.response?.status,
    err?.error?.code,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const status = Number(candidate);
    if (Number.isInteger(status)) return status;
  }
  return null;
}

function isRetryableAiError(err) {
  const status = getErrorStatus(err);
  if ([408, 409, 425, 429].includes(status) || (status != null && status >= 500)) return true;

  const code = String(err?.code || err?.cause?.code || "").toUpperCase();
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
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

function looksLikeDailyQuota(message) {
  const text = String(message || "").toLowerCase();
  return /quota_exceeded|requests per day|per-day|per day|daily quota|\brpd\b/.test(text);
}

function classifyCandidateHealthFailure(err) {
  const status = getErrorStatus(err);
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();

  if (status === 429 || /rate limit|quota|resource exhausted|too many requests/.test(message)) {
    return looksLikeDailyQuota(message)
      ? { status: "rate_limited", failureKind: "quota_exhausted" }
      : { status: "rate_limited", failureKind: "rate_limit" };
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

function cooldownMsForOutcome(candidate, outcome, env = process.env) {
  if (candidate?.provider !== "gemini") return 0;
  if (outcome?.status === "rate_limited") {
    if (outcome.failureKind === "quota_exhausted") {
      return positiveInt(
        env.GEMINI_QUOTA_COOLDOWN_MS,
        DEFAULT_QUOTA_COOLDOWN_MS
      );
    }
    return positiveInt(
      env.GEMINI_RATE_LIMIT_COOLDOWN_MS,
      DEFAULT_RATE_LIMIT_COOLDOWN_MS
    );
  }
  if (outcome?.status === "unavailable") {
    return positiveInt(
      env.GEMINI_UNAVAILABLE_COOLDOWN_MS,
      DEFAULT_UNAVAILABLE_COOLDOWN_MS
    );
  }
  if (outcome?.status === "invalid") {
    return positiveInt(
      env.GEMINI_INVALID_KEY_COOLDOWN_MS,
      DEFAULT_INVALID_COOLDOWN_MS
    );
  }
  return 0;
}

function recordCandidateHealth(
  candidate,
  outcome,
  { env = process.env, persist = true, now = () => new Date() } = {}
) {
  if (!candidate?.healthKey || !candidate?.provider || !outcome?.status) return;
  const at = now();
  const previous = runtimeCandidateHealth.get(candidate.healthKey) || {};
  const failed = outcome.status !== "ready";
  const cooldownMs = failed ? cooldownMsForOutcome(candidate, outcome, env) : 0;
  const cooldownUntil = cooldownMs > 0
    ? new Date(at.getTime() + cooldownMs)
    : null;

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
    cooldown_until: cooldownUntil,
  });

  if (candidate.provider === "gemini") {
    if (outcome.status === "ready") {
      activeGeminiHealthKey = candidate.healthKey;
    } else if (candidate.healthKey === activeGeminiHealthKey && cooldownMs > 0) {
      activeGeminiHealthKey = null;
    }
  }

  if (!persist) return;
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

function getGeminiCandidateDescriptors(env = process.env) {
  return getGeminiApiKeys(env).map((apiKey, index) => ({
    apiKey,
    index,
    label: `Gemini key ${index + 1}`,
    provider: "gemini",
    healthKey: `gemini_${credentialFingerprint(apiKey)}`,
  }));
}

function cooldownUntilMs(candidate) {
  const value = runtimeCandidateHealth.get(candidate.healthKey)?.cooldown_until;
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOrderedGeminiCandidates(env = process.env, nowMs = Date.now()) {
  const candidates = getGeminiCandidateDescriptors(env);
  const available = candidates.filter((candidate) => cooldownUntilMs(candidate) <= nowMs);
  const cooling = candidates.filter((candidate) => cooldownUntilMs(candidate) > nowMs);

  available.sort((a, b) => {
    if (a.healthKey === activeGeminiHealthKey) return -1;
    if (b.healthKey === activeGeminiHealthKey) return 1;
    return a.index - b.index;
  });
  cooling.sort((a, b) => cooldownUntilMs(a) - cooldownUntilMs(b));
  return { available, cooling };
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs) return Promise.resolve(promise);
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

function computeAttemptTimeoutMs({
  remainingBudgetMs,
  candidatePosition,
  totalCandidates,
  preferredTimeoutMs,
  fallbackTimeoutMs,
  minRemainingKeyWindowMs,
}) {
  if (!(remainingBudgetMs > 0)) return 0;
  const remainingCandidates = Math.max(0, totalCandidates - candidatePosition - 1);
  const reserveForLaterKeys = remainingCandidates * Math.max(0, minRemainingKeyWindowMs || 0);
  const baseTimeout = candidatePosition === 0 ? preferredTimeoutMs : fallbackTimeoutMs;
  const usableNow = Math.max(1, remainingBudgetMs - reserveForLaterKeys);
  return Math.max(1, Math.min(baseTimeout || remainingBudgetMs, usableNow, remainingBudgetMs));
}

function shouldRetrySameGeminiKey(err, outcome, { attempt, retryCount, smartRetry = false }) {
  if (attempt >= retryCount) return false;
  if (!smartRetry) {
    return isRetryableAiError(err) && !["rate_limited", "invalid"].includes(outcome.status);
  }

  if (outcome.failureKind === "invalid_response") return true;
  const status = getErrorStatus(err);
  return status != null && status >= 500 && status <= 599;
}

function smartRetryDelayMs(err, { minMs = 500, maxMs = 1000, randomFn = Math.random } = {}) {
  const status = getErrorStatus(err);
  if (!(status != null && status >= 500 && status <= 599)) return 0;
  const low = Math.max(0, Math.min(minMs, maxMs));
  const high = Math.max(low, maxMs);
  return Math.round(low + (high - low) * Math.max(0, Math.min(1, randomFn())));
}

function createBudgetError(failures) {
  const err = new Error("Gemini reply time budget was exhausted.");
  err.code = "GEMINI_GLOBAL_BUDGET_EXCEEDED";
  err.failures = failures.map(({ label, error }) => ({
    label,
    message: String(error?.message || "Gemini request failed.").slice(0, 240),
  }));
  return err;
}

async function runWithGeminiKeys(
  operation,
  {
    env = process.env,
    retryCount = 1,
    retryDelaysMs = [],
    timeoutMs = 0,
    globalBudgetMs = 0,
    preferredTimeoutMs = 0,
    fallbackTimeoutMs = 0,
    minRemainingKeyWindowMs = 0,
    smartRetry = false,
    smartRetryDelayMinMs = 500,
    smartRetryDelayMaxMs = 1000,
    persistHealth = true,
    now = () => new Date(),
    clock = () => Date.now(),
    randomFn = Math.random,
    sleepFn = sleep,
  } = {}
) {
  const nowValue = now();
  const { available, cooling } = getOrderedGeminiCandidates(env, nowValue.getTime());

  if (!available.length) {
    const err = new Error(
      cooling.length
        ? "All configured Gemini keys are temporarily cooling down."
        : "No Gemini API key is configured."
    );
    err.code = cooling.length
      ? "ALL_GEMINI_KEYS_COOLING_DOWN"
      : "AI_PROVIDER_NOT_CONFIGURED";
    if (cooling.length) {
      const nextRetryAt = cooldownUntilMs(cooling[0]);
      err.nextRetryAt = nextRetryAt ? new Date(nextRetryAt) : null;
    }
    throw err;
  }

  const failures = [];
  const boundedRetryCount = Math.max(0, Math.min(Number(retryCount) || 0, 3));
  const startedAtMs = clock();

  for (let candidatePosition = 0; candidatePosition < available.length; candidatePosition += 1) {
    const candidate = available[candidatePosition];
    let lastError = null;

    for (let attempt = 0; attempt <= boundedRetryCount; attempt += 1) {
      const elapsedMs = Math.max(0, clock() - startedAtMs);
      const remainingBudgetMs = globalBudgetMs > 0
        ? globalBudgetMs - elapsedMs
        : Number.POSITIVE_INFINITY;
      if (remainingBudgetMs <= 0) throw createBudgetError(failures);

      const attemptTimeoutMs = globalBudgetMs > 0
        ? computeAttemptTimeoutMs({
            remainingBudgetMs,
            candidatePosition,
            totalCandidates: available.length,
            preferredTimeoutMs: preferredTimeoutMs || timeoutMs,
            fallbackTimeoutMs: fallbackTimeoutMs || timeoutMs,
            minRemainingKeyWindowMs,
          })
        : timeoutMs;

      try {
        const result = await withTimeout(
          operation(candidate.apiKey, candidate),
          attemptTimeoutMs,
          candidate.label
        );
        recordCandidateHealth(
          candidate,
          { status: "ready", failureKind: null },
          { env, persist: persistHealth, now }
        );
        return result;
      } catch (err) {
        lastError = err;
        const outcome = classifyCandidateHealthFailure(err);
        recordCandidateHealth(candidate, outcome, {
          env,
          persist: persistHealth,
          now,
        });

        const sameKeyRetry = shouldRetrySameGeminiKey(err, outcome, {
          attempt,
          retryCount: boundedRetryCount,
          smartRetry,
        });
        console.warn(
          `${candidate.label} attempt ${attempt + 1} failed${sameKeyRetry ? "; retrying" : "; rotating"}:`,
          err?.message || err
        );
        if (!sameKeyRetry) break;

        let delayMs = Number(retryDelaysMs[attempt]) || 0;
        if (smartRetry && delayMs <= 0) {
          delayMs = smartRetryDelayMs(err, {
            minMs: smartRetryDelayMinMs,
            maxMs: smartRetryDelayMaxMs,
            randomFn,
          });
        }
        if (globalBudgetMs > 0) {
          const remainingBeforeDelay = globalBudgetMs - Math.max(0, clock() - startedAtMs);
          if (remainingBeforeDelay <= 0) throw createBudgetError(failures);
          delayMs = Math.min(delayMs, Math.max(0, remainingBeforeDelay - 1));
        }
        if (delayMs > 0) await sleepFn(delayMs);
      }
    }

    failures.push({ label: candidate.label, error: lastError });
    if (globalBudgetMs > 0 && clock() - startedAtMs >= globalBudgetMs) {
      throw createBudgetError(failures);
    }
  }

  const err = new Error("All available Gemini keys failed.");
  err.code = "ALL_GEMINI_KEYS_FAILED";
  err.failures = failures.map(({ label, error }) => ({
    label,
    message: String(error?.message || "Gemini request failed.").slice(0, 240),
  }));
  throw err;
}

function resetGeminiKeyPoolState() {
  runtimeCandidateHealth.clear();
  activeGeminiHealthKey = null;
}

module.exports = {
  DEFAULT_INVALID_COOLDOWN_MS,
  DEFAULT_QUOTA_COOLDOWN_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_UNAVAILABLE_COOLDOWN_MS,
  classifyCandidateHealthFailure,
  computeAttemptTimeoutMs,
  cooldownMsForOutcome,
  credentialFingerprint,
  getGeminiApiKeys,
  getGeminiCandidateDescriptors,
  getOrderedGeminiCandidates,
  getRuntimeCandidateHealth,
  isRetryableAiError,
  recordCandidateHealth,
  resetGeminiKeyPoolState,
  runWithGeminiKeys,
  shouldRetrySameGeminiKey,
  smartRetryDelayMs,
};
