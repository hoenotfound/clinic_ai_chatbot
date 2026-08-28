/**
 * Basic brute-force protection for POST /api/auth/login.
 *
 * Tracks failed attempts in memory, keyed by IP + the attempted username
 * (so one bad actor guessing many usernames from one IP, or one attacker
 * spraying one username from many IPs, both get slowed down without
 * locking out a whole shared office network over one typo'd password).
 *
 * Deliberately in-memory rather than Postgres-backed: this is a small
 * front-desk portal, not a public-facing consumer login, so a plain
 * per-process counter is enough. If this app is ever run as multiple
 * server instances behind a load balancer, each instance tracks its own
 * counts — an attacker who can spread requests across instances gets a
 * multiple of this limit, which is an acceptable tradeoff for the
 * simplicity here (revisit with a shared store, e.g. Postgres or Redis,
 * if that ever becomes a real deployment shape).
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10; // failed attempts allowed per key within the window
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // prune stale entries twice an hour

// key -> { count, firstAttemptAt }
const attempts = new Map();

function keyFor(req) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const username = String(req.body?.username || "").trim().toLowerCase();
  return `${ip}::${username}`;
}

function loginRateLimit(req, res, next) {
  const key = keyFor(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (entry && now - entry.firstAttemptAt < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((entry.firstAttemptAt + WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({
      error: "Too many login attempts. Please wait a few minutes and try again.",
    });
  }

  next();
}

/** Called by the login route on a failed login — increments the counter for this key. */
function recordFailedAttempt(req) {
  const key = keyFor(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAttemptAt >= WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now });
    return;
  }

  entry.count += 1;
}

/** Called by the login route on a successful login — clears any history for this key. */
function clearAttempts(req) {
  attempts.delete(keyFor(req));
}

// Best-effort cleanup so memory doesn't grow unbounded with every mistyped
// login attempt ever made — entries outside the window are just dead weight.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAttemptAt >= WINDOW_MS) {
      attempts.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

module.exports = { loginRateLimit, recordFailedAttempt, clearAttempts };
