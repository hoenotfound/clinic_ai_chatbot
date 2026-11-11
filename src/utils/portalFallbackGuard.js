"use strict";

// Keep the SPA fallback restricted to routes that React actually handles.
// Meta callbacks, API endpoints and static files are registered earlier in
// createApp and must never be routed through this handler.
const path = require("node:path");
const { createHmac, randomBytes } = require("node:crypto");

const PORTAL_ROUTES = new Set([
  "/login", "/inbox", "/contacts", "/pipeline", "/sales-follow-up",
  "/analytics", "/tools", "/promotional-blast", "/notifications", "/tools/lead-distribution",
  "/conversation-flow", "/settings", "/settings/notifications", "/settings/client-setup",
  "/settings/team", "/settings/go-live", "/settings/setup",
  "/settings/advanced-config", "/setup", "/no-access",
]);

function isKnownPortalRoute(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const normalized = pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return PORTAL_ROUTES.has(normalized);
}

// Limit only unrecognized GET/HEAD routes; no legitimate portal page,
// WhatsApp/Meta webhook, auth/API route, static asset or health check is
// subject to this limiter. Identifiers are keyed with an ephemeral HMAC
// and never written to logs, SQL, or response diagnostics.
function createUnknownPathLimiter({
  now = Date.now,
  windowMs = 5 * 60 * 1000,
  maxRequests = 40,
  maxEntries = 1024,
  salt = randomBytes(32),
} = {}) {
  const counts = new Map();
  return function checkUnknownPath(address) {
    const key = createHmac("sha256", salt).update(String(address || "unknown")).digest("hex");
    const timestamp = now();
    let entry = counts.get(key);
    if (!entry || entry.expiresAt <= timestamp) {
      // Bound memory even when a scanner rotates source addresses.
      if (counts.size >= maxEntries) {
        for (const [existingKey, existing] of counts) {
          if (existing.expiresAt <= timestamp) counts.delete(existingKey);
        }
        if (counts.size >= maxEntries) counts.delete(counts.keys().next().value);
      }
      entry = { count: 0, expiresAt: timestamp + windowMs };
    }
    entry.count += 1;
    // Move the most recently seen source to the back for bounded eviction.
    counts.delete(key);
    counts.set(key, entry);
    return {
      limited: entry.count > maxRequests,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - timestamp) / 1000)),
    };
  };
}

function createPortalFallback(portalBuildPath, {
  limiter = createUnknownPathLimiter(),
} = {}) {
  const indexHtml = path.join(portalBuildPath, "index.html");
  return (req, res) => {
    if (isKnownPortalRoute(req.path)) {
      return res.sendFile(indexHtml, (err) => {
        if (err && !res.headersSent) {
          res.status(404).type("text/plain").send("Portal not built yet.");
        } else if (err) {
          res.end();
        }
      });
    }
    const checked = limiter(req.ip || req.socket?.remoteAddress || "unknown");
    res.set("Cache-Control", "no-store");
    if (checked.limited) {
      return res.status(429).set("Retry-After", String(checked.retryAfterSeconds))
        .type("text/plain").send("Too many invalid requests.");
    }
    return res.status(404).type("text/plain").send("Not found.");
  };
}

module.exports = { isKnownPortalRoute, createUnknownPathLimiter, createPortalFallback };
