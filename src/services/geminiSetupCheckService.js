const { GoogleGenAI } = require("@google/genai");
const { getGeminiApiKeys } = require("./geminiKeyPool");

const DEFAULT_MODEL = "gemini-2.5-flash";

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
  return /api.?key.*(invalid|expired|rejected)|invalid.*api.?key|unauthorized/.test(message);
}

async function checkGeminiConnection({
  env = process.env,
  createClient = (apiKey) => new GoogleGenAI({ apiKey }),
} = {}) {
  const keys = getGeminiApiKeys(env);
  if (!keys.length) {
    const error = new Error("No Gemini API key is configured.");
    error.code = "AI_PROVIDER_NOT_CONFIGURED";
    throw error;
  }

  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  let lastCredentialError = null;

  for (let index = 0; index < keys.length; index += 1) {
    try {
      const ai = createClient(keys[index]);
      const info = await ai.models.get({ model });
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
  checkGeminiConnection,
  errorStatus,
  isCredentialError,
};
