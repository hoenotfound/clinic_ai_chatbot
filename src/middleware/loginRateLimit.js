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

/**
 * States passed here already include the current request's atomic reservation.
 * Therefore the configured number is the number of attempts that may proceed;
 * the next reservation (max + 1) is the first one that receives HTTP 429.
 */
function retryAfterForState(state, nowMs) {
  const maxAttempts = MAX_ATTEMPTS_BY_SCOPE[state?.scope];
  if (!maxAttempts || Number(state?.failures) <= maxAttempts) return 0;

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
  const reservationKey = Symbol("login-rate-limit-reservation");

  function maybePrune() {
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
  }

  async function reserveAttempt(req) {
    const existing = req?.[reservationKey];
    if (existing) return existing;

    const keys = keysForRequest(req, env);
    const states = await repository.recordFailure(
      keys,
      { windowSeconds: WINDOW_SECONDS }
    );
    const reservation = { keys, states };
    if (req) req[reservationKey] = reservation;
    maybePrune();
    return reservation;
  }

  async function loginRateLimit(req, res, next) {
    try {
      // Reserve/count this request before bcrypt or user lookup. The database
      // increment is atomic, so a parallel burst cannot all pass based on the
      // same stale pre-failure counter.
      const { states } = await reserveAttempt(req);
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
      console.error("Failed to reserve login rate-limit state:", err);
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        error: "Login is temporarily unavailable. Please try again shortly.",
      });
    }
  }

  async function recordFailedAttempt(req) {
    // Normal login requests were already counted before credential verification.
    // Keep this method for the route contract and direct callers without ever
    // double-counting a rejected password.
    return reserveAttempt(req).then((reservation) => reservation.states);
  }

  async function clearAttempts(req) {
    const reservation = req?.[reservationKey];
    const keys = reservation?.keys || keysForRequest(req, env);

    // A valid login should remove only its own pre-auth reservation. Never
    // delete the username/pair rows wholesale: another failed login may have
    // reserved the same bucket concurrently and must remain counted.
    return repository.decrementKeys(keys);
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
