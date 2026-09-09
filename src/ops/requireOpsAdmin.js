const crypto = require("crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest();
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function parseBasicAuth(header) {
  const match = String(header || "").match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch (_) {
    return null;
  }
}

function createRequireOpsAdmin({ env = process.env } = {}) {
  const expectedUsername = String(env.OPS_REGISTRY_ADMIN_USERNAME || "").trim();
  const expectedPassword = String(env.OPS_REGISTRY_ADMIN_PASSWORD || "");
  if (!expectedUsername || expectedPassword.length < 16) {
    throw new Error(
      "OPS_REGISTRY_ADMIN_USERNAME and an OPS_REGISTRY_ADMIN_PASSWORD of at least 16 characters are required."
    );
  }

  return function requireOpsAdmin(req, res, next) {
    const credentials = parseBasicAuth(req.get("authorization"));
    if (
      !credentials
      || !safeEqual(credentials.username, expectedUsername)
      || !safeEqual(credentials.password, expectedPassword)
    ) {
      res.set("WWW-Authenticate", 'Basic realm="DA Ops Registry"');
      return res.status(401).send("Authentication required.");
    }
    res.set("Cache-Control", "no-store");
    return next();
  };
}

module.exports = {
  createRequireOpsAdmin,
  parseBasicAuth,
  safeEqual,
};
