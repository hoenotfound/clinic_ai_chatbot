const crypto = require("crypto");
const loginRateLimitRepo = require("../db/loginRateLimitRepo");

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_SECONDS = Math.floor(WINDOW_MS / 1000);
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
const RETENTION_SECONDS = 24 * 60 * 60;

// Pair is the tightest limit for repeated guesses from one device. Username
// protects one account from a distributed spray, while the higher IP ceiling
// slows one source trying many usernames without making a shared clinic/office
// network easy to lock out because of a few staff typos.
const MAX_ATTEMPTS_BY_SCOPE = Object.freeze({
  pair: 8,
  username: 15,
  ip: 40,
});

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().slice(0, 200);
}

function normalizeIp(value) {
  let ip = String(value || "unknown").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip.slice(0, 200) || "unknown";
}

/**
 * Render documents that it places the real client address first in
 * X-Forwarded-For. Use that only when Render's own RENDER=true environment flag
 * is present. Everywhere else, prefer the direct socket peer instead of
 * trusting an arbitrary forwarded header supplied by an internet client.
 */
function extractClientIp(req, env = process.env) {
  const socketIp =
    req?.socket?.remoteAddress ||
    req?.connection?.remoteAddress ||
    "unknown";

  if (String(env?.RENDER || "").toLowerCase() === "true") {
    const forwarded = req?.headers?.["x-forwarded-for"];
    const first = Array.isArray(forwarded)
      ? String(forwarded[0] || "").split(",")[0]
      : String(forwarded || "").split(",")[0];
    if (first.trim()) return normalizeIp(first);
  }

  return normalizeIp(socketIp);
}

function secretForRateLimit(env = process.env) {
  const configured = String(
    env?.LOGIN_RATE_LIMIT_SECRET || env?.SESSION_SECRET || ""
  ).trim();
  // Production already refuses to start without SESSION_SECRET. The fallback
  // exists only so isolated unit tests/local imports remain deterministic.
  return configured || "local-development-login-rate-limit-secret";
}

function hashIdentifier(scope, value, secret) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${scope}\n${value}`)
    .digest("hex");
}

function keysForRequest(req, env = process.env) {
  const ip = extractClientIp(req, env);
  const username = normalizeUsername(req?.body?.username);
  const secret = secretForRateLimit(env);
  const keys = [
    {
      scope: "ip",
      keyHash: hashIdentifier("ip", ip, secret),
    },
  ];

  if (username) {
    keys.push(
      {
        scope: "username",
        keyHash: hashIdentifier("username", username, secret),
      },
      {
        scope: "pair",
        keyHash: hashIdentifier("pair", `${ip}\n${username}`, secret),
      }
    );
  }

  return keys;
}

function retryAfterForState(state, nowMs) {
  const maxAttempts = MAX_ATTEMPTS_BY_SCOPE[state?.scope];
  if (!maxAttempts || Number(state?.failures) < maxAttempts) return 0;

  const startedAt = new Date(state.window_started_at).getTime();
  if (!Number.isFinite(startedAt)) return 0;
  const remainingMs = startedAt + WINDOW_MS - nowMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function createLoginRateLimiter({
  repository = loginRateLimitRepo,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  let lastCleanupAt = 0;

  async function loginRateLimit(req, res, next) {
    try {
      const states = await repository.getStates(keysForRequest(req, env));
      const current = now();
      const retryAfter = states.reduce(
        (max, state) => Math.max(max, retryAfterForState(state, current)),
        0
      );

      if (retryAfter > 0) {
        res.set("Retry-After", String(retryAfter));
        res.set("Cache-Control", "no-store");
        return res.status(429).json({
          error: "Too many login attempts. Please wait a few minutes and try again.",
        });
      }

      return next();
    } catch (err) {
      // Authentication depends on Postgres anyway. Fail closed instead of
      // silently disabling brute-force protection during a database outage.
      console.error("Failed to verify login rate-limit state:", err);
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        error: "Login is temporarily unavailable. Please try again shortly.",
      });
    }
  }

  async function recordFailedAttempt(req) {
    const result = await repository.recordFailure(
      keysForRequest(req, env),
      { windowSeconds: WINDOW_SECONDS }
    );

    const current = now();
    if (
      typeof repository.pruneExpired === "function" &&
      current - lastCleanupAt >= CLEANUP_INTERVAL_MS
    ) {
      lastCleanupAt = current;
      repository.pruneExpired({ olderThanSeconds: RETENTION_SECONDS }).catch((err) => {
        console.warn("Failed to prune old login rate-limit rows:", err?.message || err);
      });
    }

    return result;
  }

  async function clearAttempts(req) {
    // Do not clear the IP-wide bucket on success. Otherwise an attacker who has
    // one valid account could repeatedly reset protection for a source that is
    // spraying many other usernames. A successful account does clear its own
    // username and IP+username history so genuine staff recover immediately.
    const keys = keysForRequest(req, env).filter((key) => key.scope !== "ip");
    return repository.clearKeys(keys);
  }

  return {
    clearAttempts,
    loginRateLimit,
    recordFailedAttempt,
  };
}

const defaultLimiter = createLoginRateLimiter();

module.exports = {
  CLEANUP_INTERVAL_MS,
  MAX_ATTEMPTS_BY_SCOPE,
  RETENTION_SECONDS,
  WINDOW_MS,
  WINDOW_SECONDS,
  clearAttempts: defaultLimiter.clearAttempts,
  createLoginRateLimiter,
  extractClientIp,
  hashIdentifier,
  keysForRequest,
  loginRateLimit: defaultLimiter.loginRateLimit,
  normalizeIp,
  normalizeUsername,
  recordFailedAttempt: defaultLimiter.recordFailedAttempt,
  retryAfterForState,
};
