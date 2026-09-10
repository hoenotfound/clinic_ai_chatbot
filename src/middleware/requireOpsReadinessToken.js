const crypto = require("crypto");

function configuredOpsToken(env = process.env) {
  const token = String(env.OPS_READINESS_TOKEN || "").trim();
  return token.length >= 32 ? token : null;
}

function bearerToken(req) {
  const header = String(req.get("authorization") || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeTokenEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left || "")).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right || "")).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function createRequireOpsReadinessToken({ env = process.env } = {}) {
  return function requireOpsReadinessToken(req, res, next) {
    const expected = configuredOpsToken(env);
    if (!expected) {
      return res.status(404).json({ error: "Not found." });
    }

    const supplied = bearerToken(req);
    if (!supplied || !safeTokenEqual(supplied, expected)) {
      res.set("WWW-Authenticate", 'Bearer realm="ops-readiness"');
      return res.status(401).json({ error: "Invalid operations credential." });
    }

    res.set("Cache-Control", "no-store");
    return next();
  };
}

const requireOpsReadinessToken = createRequireOpsReadinessToken();

module.exports = {
  bearerToken,
  configuredOpsToken,
  createRequireOpsReadinessToken,
  requireOpsReadinessToken,
  safeTokenEqual,
};
