const crypto = require("crypto");

const OPS_TOKEN_PREFIX = "ops1_";
const MIN_SHARED_SECRET_LENGTH = 32;

function normalizeOpsClientId(value) {
  const clientId = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  if (!clientId) throw new Error("OPS client ID is required.");
  if (clientId.length > 80) throw new Error("OPS client ID must be 80 characters or fewer.");
  return clientId;
}

function requireSharedSecret(value) {
  const secret = String(value || "");
  if (secret.length < MIN_SHARED_SECRET_LENGTH) {
    throw new Error(`OPS_REGISTRY_SHARED_SECRET must be at least ${MIN_SHARED_SECRET_LENGTH} characters.`);
  }
  return secret;
}

function deriveOpsReadinessToken(sharedSecret, clientId) {
  const secret = requireSharedSecret(sharedSecret);
  const normalizedClientId = normalizeOpsClientId(clientId);
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`ops-readiness:v1:${normalizedClientId}`)
    .digest("base64url");
  return `${OPS_TOKEN_PREFIX}${digest}`;
}

function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  if (actualBuffer.length !== expectedBuffer.length || actualBuffer.length === 0) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function bearerToken(headerValue) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headerValue || "").trim());
  return match ? match[1].trim() : null;
}

module.exports = {
  MIN_SHARED_SECRET_LENGTH,
  OPS_TOKEN_PREFIX,
  bearerToken,
  deriveOpsReadinessToken,
  normalizeOpsClientId,
  requireSharedSecret,
  safeTokenEqual,
};
