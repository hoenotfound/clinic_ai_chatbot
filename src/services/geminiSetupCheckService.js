const { GoogleGenAI } = require("@google/genai");
const {
  classifyCandidateHealthFailure,
  getGeminiApiKeys,
  getGeminiCandidateDescriptors,
} = require("./geminiKeyPool");

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_SETUP_CHECK_TIMEOUT_MS = 8 * 1000;
const DEFAULT_MODEL_DIAGNOSTIC_TIMEOUT_MS = 10 * 1000;
const DIAGNOSTIC_MODELS = Object.freeze([
  "gemini-3.5-flash",
  "gemini-3.8-flash",
]);
const DIAGNOSTIC_MAX_KEYS = 5;

function errorStatus(error) {
  const value = error?.status ?? error?.statusCode ?? error?.response?.status;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function providerStatus(error) {
  return String(
    error?.error?.status
      || error?.response?.data?.error?.status
      || error?.response?.body?.error?.status
      || error?.details?.error?.status
      || ""
  ).trim().toUpperCase();
}

function isCredentialError(error) {
  const status = errorStatus(error);
  const remoteStatus = providerStatus(error);
  const code = String(
    error?.code
      || error?.error?.code
      || error?.response?.data?.error?.code
      || error?.cause?.code
      || ""
  ).toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  if ([401, 403].includes(status)) return true;
  if (["UNAUTHENTICATED", "PERMISSION_DENIED", "API_KEY_INVALID"].includes(remoteStatus)) return true;
  if (["UNAUTHENTICATED", "PERMISSION_DENIED", "API_KEY_INVALID"].includes(code)) return true;
  return /api.?key.*(invalid|not valid|expired|rejected)|invalid.*api.?key|unauthorized/.test(message);
}

function boundedTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SETUP_CHECK_TIMEOUT_MS;
  return Math.max(100, Math.min(30 * 1000, Math.round(parsed)));
}

function boundedDiagnosticTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MODEL_DIAGNOSTIC_TIMEOUT_MS;
  return Math.max(500, Math.min(30 * 1000, Math.round(parsed)));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Gemini model metadata check timed out after ${timeoutMs}ms.`);
        error.code = "GEMINI_SETUP_CHECK_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function withDiagnosticTimeout(promise, timeoutMs, model, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} ${model} diagnostic timed out after ${timeoutMs}ms.`);
        error.code = "AI_TIMEOUT";
        reject(error);
      }, timeoutMs);
    }),
  ]);
}

function numericToken(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function diagnosticUsage(response) {
  const usage = response?.usageMetadata || {};
  return {
    promptTokens: numericToken(usage.promptTokenCount),
    outputTokens: numericToken(usage.candidatesTokenCount),
    thinkingTokens: numericToken(usage.thoughtsTokenCount),
    totalTokens: numericToken(usage.totalTokenCount),
  };
}

function diagnosticFailure(error) {
  const outcome = isCredentialError(error)
    ? { status: "invalid", failureKind: "authentication" }
    : classifyCandidateHealthFailure(error);
  return {
    status: outcome.status,
    failureKind: outcome.failureKind,
    httpStatus: errorStatus(error),
    providerStatus: providerStatus(error) || null,
    message: String(error?.message || "Gemini diagnostic failed.").slice(0, 240),
  };
}

async function checkGeminiConnection({
  env = process.env,
  createClient = (apiKey) => new GoogleGenAI({ apiKey }),
  timeoutMs = DEFAULT_SETUP_CHECK_TIMEOUT_MS,
} = {}) {
  const keys = getGeminiApiKeys(env);
  if (!keys.length) {
    const error = new Error("No Gemini API key is configured.");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const checkTimeoutMs = boundedTimeoutMs(timeoutMs);
  let lastCredentialError = null;

  for (let index = 0; index < keys.length; index += 1) {
    try {
      const ai = createClient(keys[index]);
      const info = await withTimeout(ai.models.get({ model }), checkTimeoutMs);
      if (!info) {
        const error = new Error("Gemini returned no model metadata.");
        error.code = "GEMINI_MODEL_METADATA_EMPTY";
        throw error;
      }
      return {
        provider: "gemini",
        model,
        keyLabel: `Gemini key ${index + 1}`,
        modelName: info.name || model,
        supportedActions: Array.isArray(info.supportedActions) ? info.supportedActions : [],
      };
    } catch (error) {
      // A rejected credential can be checked with the next configured key.
      // Provider/model failures and timeouts stop immediately so this legacy
      // single-connection helper remains conservative.
      if (isCredentialError(error) && index < keys.length - 1) {
        lastCredentialError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastCredentialError || new Error("No configured Gemini key could access the model metadata endpoint.");
}

/**
 * Check every configured Gemini credential using model metadata only.
 *
 * This intentionally calls models.get() rather than generateContent(). It sends
 * no prompt and produces no model output, so it consumes 0 prompt/output
 * generation tokens. Each key is checked independently and in parallel so five
 * keys still take roughly one metadata timeout window instead of five.
 *
 * These results are setup diagnostics only. They must not be fed into the
 * runtime key-pool health/cooldown state used for customer replies.
 */
async function checkAllGeminiConnections({
  env = process.env,
  createClient = (apiKey) => new GoogleGenAI({ apiKey }),
  timeoutMs = DEFAULT_SETUP_CHECK_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  const candidates = getGeminiCandidateDescriptors(env);
  if (!candidates.length) {
    const error = new Error("No Gemini API key is configured.");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const checkTimeoutMs = boundedTimeoutMs(timeoutMs);

  const results = await Promise.all(candidates.map(async (candidate) => {
    const checkedAt = now();
    try {
      const ai = createClient(candidate.apiKey);
      const info = await withTimeout(ai.models.get({ model }), checkTimeoutMs);
      if (!info) {
        const error = new Error("Gemini returned no model metadata.");
        error.code = "GEMINI_MODEL_METADATA_EMPTY";
        throw error;
      }
      return {
        healthKey: candidate.healthKey,
        provider: "gemini",
        label: candidate.label,
        status: "ready",
        failureKind: null,
        checkedAt,
        modelName: info.name || model,
      };
    } catch (error) {
      const outcome = isCredentialError(error)
        ? { status: "invalid", failureKind: "authentication" }
        : classifyCandidateHealthFailure(error);
      return {
        healthKey: candidate.healthKey,
        provider: "gemini",
        label: candidate.label,
        status: outcome.status,
        failureKind: outcome.failureKind,
        checkedAt,
      };
    }
  }));

  return {
    provider: "gemini",
    model,
    results,
    readyCount: results.filter((item) => item.status === "ready").length,
    totalCount: results.length,
  };
}

/**
 * Run a deliberately tiny real generation on the first five configured Gemini
 * keys against Gemini 3.5 Flash and 3.8 Flash. This is separate from normal
 * Setup Status because a real generation consumes request quota even when it
 * uses almost no tokens.
 *
 * Each successful request sends a one-character prompt and caps model output at
 * one token with the lowest supported Gemini 3.x thinking level. Tests are run
 * sequentially so the diagnostic itself does not create a burst across keys.
 * Runtime key health, active-key preference, cooldowns and AI usage telemetry
 * are not changed by this diagnostic.
 */
async function runGeminiKeyModelDiagnostic({
  env = process.env,
  createClient = (apiKey) => new GoogleGenAI({ apiKey }),
  timeoutMs = DEFAULT_MODEL_DIAGNOSTIC_TIMEOUT_MS,
  models = DIAGNOSTIC_MODELS,
  maxKeys = DIAGNOSTIC_MAX_KEYS,
  clock = () => Date.now(),
  now = () => new Date(),
} = {}) {
  const candidates = getGeminiCandidateDescriptors(env).slice(0, Math.max(1, Number(maxKeys) || DIAGNOSTIC_MAX_KEYS));
  if (!candidates.length) {
    const error = new Error("No Gemini API key is configured.");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const checkedModels = [...new Set(
    (Array.isArray(models) ? models : DIAGNOSTIC_MODELS)
      .map((model) => String(model || "").trim())
      .filter(Boolean)
  )];
  if (!checkedModels.length) {
    const error = new Error("No Gemini diagnostic model is configured.");
    error.code = "GEMINI_DIAGNOSTIC_MODEL_NOT_CONFIGURED";
    throw error;
  }

  const checkTimeoutMs = boundedDiagnosticTimeoutMs(timeoutMs);
  const results = [];

  for (const candidate of candidates) {
    const ai = createClient(candidate.apiKey);
    for (const model of checkedModels) {
      const startedAt = clock();
      const checkedAt = now();
      try {
        const response = await withDiagnosticTimeout(
          ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text: "." }] }],
            config: {
              maxOutputTokens: 1,
              thinkingConfig: { thinkingLevel: "low" },
            },
          }),
          checkTimeoutMs,
          model,
          candidate.label
        );
        results.push({
          label: candidate.label,
          fingerprint: candidate.healthKey.replace(/^gemini_/, "").slice(0, 8),
          model,
          status: "ready",
          failureKind: null,
          httpStatus: 200,
          providerStatus: null,
          latencyMs: Math.max(0, clock() - startedAt),
          checkedAt,
          ...diagnosticUsage(response),
        });
      } catch (error) {
        results.push({
          label: candidate.label,
          fingerprint: candidate.healthKey.replace(/^gemini_/, "").slice(0, 8),
          model,
          ...diagnosticFailure(error),
          latencyMs: Math.max(0, clock() - startedAt),
          checkedAt,
          promptTokens: 0,
          outputTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
        });
      }
    }
  }

  return {
    provider: "gemini",
    models: checkedModels,
    keyCount: candidates.length,
    requestsAttempted: results.length,
    successfulRequests: results.filter((item) => item.status === "ready").length,
    totalTokens: results.reduce((sum, item) => sum + numericToken(item.totalTokens), 0),
    results,
  };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MODEL_DIAGNOSTIC_TIMEOUT_MS,
  DEFAULT_SETUP_CHECK_TIMEOUT_MS,
  DIAGNOSTIC_MAX_KEYS,
  DIAGNOSTIC_MODELS,
  boundedDiagnosticTimeoutMs,
  boundedTimeoutMs,
  checkAllGeminiConnections,
  checkGeminiConnection,
  diagnosticFailure,
  diagnosticUsage,
  errorStatus,
  isCredentialError,
  providerStatus,
  runGeminiKeyModelDiagnostic,
  withDiagnosticTimeout,
  withTimeout,
};
