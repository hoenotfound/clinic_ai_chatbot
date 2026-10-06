const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const PORTAL_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://connect.facebook.net",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://connect.facebook.net https://www.facebook.com https://web.facebook.com https://business.facebook.com https://graph.facebook.com",
  "frame-src 'self' https://www.facebook.com https://web.facebook.com https://business.facebook.com",
  "manifest-src 'self'",
].join("; ");

function buildPortalSessionOptions(sessionSecret, env = process.env) {
  return {
    name: "session",
    secret: sessionSecret,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
  };
}

function enforcePortalRequestOrigin(req, res, next) {
  if (SAFE_METHODS.has(String(req.method || "GET").toUpperCase())) {
    return next();
  }

  const fetchSite = String(req.get?.("sec-fetch-site") || "").toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    return res.status(403).json({ error: "Cross-site API request blocked." });
  }

  const origin = req.get?.("origin");
  if (!origin) return next();

  let originValue;
  try {
    originValue = new URL(origin).origin;
  } catch (_) {
    return res.status(403).json({ error: "Invalid request origin." });
  }

  const host = req.get?.("host");
  if (!host) {
    return res.status(403).json({ error: "Request host could not be verified." });
  }

  const expectedOrigin = `${req.protocol}://${host}`;
  if (originValue !== expectedOrigin) {
    return res.status(403).json({ error: "Cross-origin API request blocked." });
  }

  return next();
}

function applyPortalSecurityHeaders(_req, res, next) {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer");
  res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.set("Content-Security-Policy", PORTAL_CSP);
  next();
}

module.exports = {
  PORTAL_CSP,
  applyPortalSecurityHeaders,
  buildPortalSessionOptions,
  enforcePortalRequestOrigin,
};
