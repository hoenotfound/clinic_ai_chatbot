const PORTAL_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
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
};
