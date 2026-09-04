const { GoogleGenAI } = require("@google/genai");
const { getGeminiApiKeys } = require("./geminiKeyPool");

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_SETUP_CHECK_TIMEOUT_MS = 8 * 1000;

function errorStatus(error) {
  const value = error?.status ?? error?.statusCode ?? error?.response?.status;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function isCredentialError(error) {
  const status = errorStatus(error);
  const providerStatus = String(
    error?.error?.status
      || error?.response?.data?.error?.status
      || error?.response?.body?.error?.status
      || ""
  ).toUpperCase();
  const code = String(
    error?.code
      || error?.error?.code
      || error?.response?.data?.error?.code
      || error?.cause?.code
      || ""
  ).toUpperCase();
  const message = String(error?.message || "").toLowerCase();

  if ([401, 403].includes(status)) return true;
  if (["UNAUTHENTICATED", "PERMISSION_DENIED", "API_KEY_INVALID"].includes(providerStatus)) return true;
  if (["UNAUTHENTICATED", "PERMISSION_DENIED", "API_KEY_INVALID"].includes(code)) return true;
  return /api.?key.*(invalid|not valid|expired|rejected)|invalid.*api.?key|unauthorized/.test(message);
}

function boundedTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SETUP_CHECK_TIMEOUT_MS;
  return Math.max(100, Math.min(30 * 1000, Math.round(parsed)));
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
      // Provider/model failures and timeouts stop immediately so one Setup
      // Status click cannot fan out across the whole key pool.
      if (isCredentialError(error) && index < keys.length - 1) {
        lastCredentialError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastCredentialError || new Error("No configured Gemini key could access the model metadata endpoint.");
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_SETUP_CHECK_TIMEOUT_MS,
  boundedTimeoutMs,
  checkGeminiConnection,
  errorStatus,
  isCredentialError,
  withTimeout,
};
