"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");

// Opt-in second lock around a publicly reachable PR staging deployment.
// Never use this as the production staff-login authorization mechanism.
function equalsConstantTime(actual, expected) {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function stagingAccessGuard(req, res, next, env = process.env) {
  if (env.PR395_STAGING_BASIC_AUTH_ENABLED !== "true") return next();
  // Provider callbacks keep their own raw-body Meta signature verification.
  // Health checks stay reachable so Render can manage the staging instance.
  if (req.path === "/" || /^\/health\/(?:live|ready)$/.test(req.path) ||
      req.path === "/webhook" || req.path === "/meta-webhook") {
    return next();
  }
  res.set("Cache-Control", "no-store");
  const username = String(env.PR395_STAGING_BASIC_AUTH_USERNAME || "");
  const password = String(env.PR395_STAGING_BASIC_AUTH_PASSWORD || "");
  if (!username || password.length < 32) {
    return res.status(503).send("Staging access is not configured.");
  }
  const header = String(req.get("authorization") || "");
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="DA CHATBOT PR395 QA"');
    return res.status(401).send("Staging authentication required.");
  }
  let decoded;
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); }
  catch (_) { decoded = ""; }
  const split = decoded.indexOf(":");
  const suppliedUsername = split < 0 ? "" : decoded.slice(0, split);
  const suppliedPassword = split < 0 ? "" : decoded.slice(split + 1);
  if (!equalsConstantTime(suppliedUsername, username) ||
      !equalsConstantTime(suppliedPassword, password)) {
    res.set("WWW-Authenticate", 'Basic realm="DA CHATBOT PR395 QA"');
    return res.status(401).send("Staging authentication required.");
  }
  return next();
}

module.exports = { stagingAccessGuard, equalsConstantTime };
