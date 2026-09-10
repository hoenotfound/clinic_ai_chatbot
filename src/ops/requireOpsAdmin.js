const crypto = require("crypto");

const DEFAULT_AUTH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_MAX_FAILURES = 20;
const DEFAULT_AUTH_MAX_TRACKED_ADDRESSES = 1000;

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

function boundedPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function requestAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.get("x-forwarded-for") || "")
      .split(",")[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || "unknown";
}

function createRequireOpsAdmin({ env = process.env, now = () => Date.now() } = {}) {
  const expectedUsername = String(env.OPS_REGISTRY_ADMIN_USERNAME || "").trim();
  const expectedPassword = String(env.OPS_REGISTRY_ADMIN_PASSWORD || "");
  if (!expectedUsername || expectedPassword.length < 16) {
    throw new Error(
      "OPS_REGISTRY_ADMIN_USERNAME and an OPS_REGISTRY_ADMIN_PASSWORD of at least 16 characters are required."
    );
  }

  const windowMs = boundedPositiveInteger(
    env.OPS_AUTH_WINDOW_MS,
    DEFAULT_AUTH_WINDOW_MS,
    { min: 10_000, max: 60 * 60 * 1000 },
  );
  const maxFailures = boundedPositiveInteger(
    env.OPS_AUTH_MAX_FAILURES,
    DEFAULT_AUTH_MAX_FAILURES,
    { min: 3, max: 100 },
  );
  const maxTrackedAddresses = boundedPositiveInteger(
    env.OPS_AUTH_MAX_TRACKED_ADDRESSES,
    DEFAULT_AUTH_MAX_TRACKED_ADDRESSES,
    { min: 100, max: 10_000 },
  );
  const trustProxy = String(env.OPS_AUTH_TRUST_PROXY || "").trim().toLowerCase() === "true";
  const failures = new Map();

  function pruneExpired(currentTime) {
    for (const [key, entry] of failures) {
      if (entry.resetAt <= currentTime) failures.delete(key);
    }
  }

  function ensureCapacity(key) {
    if (failures.has(key)) return;
    while (failures.size >= maxTrackedAddresses) {
      const oldestKey = failures.keys().next().value;
      if (oldestKey == null) break;
      failures.delete(oldestKey);
    }
  }

  function currentEntry(key, currentTime) {
    const current = failures.get(key);
    if (!current) return null;
    if (current.resetAt <= currentTime) {
      failures.delete(key);
      return null;
    }
    return current;
  }

  function requireOpsAdmin(req, res, next) {
    const currentTime = now();
    pruneExpired(currentTime);

    const credentials = parseBasicAuth(req.get("authorization"));
    const key = requestAddress(req, trustProxy);
    const entry = currentEntry(key, currentTime);

    if (entry && entry.count >= maxFailures) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      res.set("Cache-Control", "no-store");
      return res.status(429).send("Too many authentication attempts.");
    }

    if (
      !credentials
      || !safeEqual(credentials.username, expectedUsername)
      || !safeEqual(credentials.password, expectedPassword)
    ) {
      ensureCapacity(key);
      const nextEntry = entry || { count: 0, resetAt: currentTime + windowMs };
      nextEntry.count += 1;
      failures.set(key, nextEntry);
      res.set("WWW-Authenticate", 'Basic realm="DA Ops Registry"');
      res.set("Cache-Control", "no-store");
      return res.status(401).send("Authentication required.");
    }

    failures.delete(key);
    res.set("Cache-Control", "no-store");
    return next();
  }

  requireOpsAdmin.trackedAddressCount = () => failures.size;
  requireOpsAdmin.pruneExpired = () => pruneExpired(now());
  return requireOpsAdmin;
}

module.exports = {
  DEFAULT_AUTH_MAX_FAILURES,
  DEFAULT_AUTH_MAX_TRACKED_ADDRESSES,
  DEFAULT_AUTH_WINDOW_MS,
  boundedPositiveInteger,
  createRequireOpsAdmin,
  parseBasicAuth,
  requestAddress,
  safeEqual,
};
