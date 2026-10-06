const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  PORTAL_CSP,
  applyPortalSecurityHeaders,
  buildPortalSessionOptions,
  enforcePortalRequestOrigin,
} = require("../src/middleware/portalSecurity");

test("production portal sessions are Secure, HttpOnly, and SameSite=Lax", () => {
  const options = buildPortalSessionOptions("test-secret", { NODE_ENV: "production" });
  assert.equal(options.secure, true);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.name, "session");
});

test("local development sessions remain usable over plain HTTP", () => {
  const options = buildPortalSessionOptions("test-secret", { NODE_ENV: "development" });
  assert.equal(options.secure, false);
});

test("portal security headers prevent framing and external script execution", () => {
  const headers = new Map();
  let nextCalled = false;
  const res = {
    set(name, value) {
      headers.set(String(name).toLowerCase(), value);
      return this;
    },
  };

  applyPortalSecurityHeaders({}, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()"
  );

  const csp = headers.get("content-security-policy");
  assert.equal(csp, PORTAL_CSP);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data: blob: https:/);
  assert.match(csp, /frame-src 'self' https:\/\/www\.facebook\.com https:\/\/web\.facebook\.com https:\/\/business\.facebook\.com/);
  assert.match(csp, /connect-src 'self'[^;]*https:\/\/graph\.facebook\.com/);
  assert.doesNotMatch(csp, /script-src[^;]*https:\s/);
});

function requestWithHeaders({
  method = "POST",
  protocol = "https",
  host = "clinic.example",
  origin = null,
  fetchSite = null,
} = {}) {
  const headers = new Map();
  if (host) headers.set("host", host);
  if (origin) headers.set("origin", origin);
  if (fetchSite) headers.set("sec-fetch-site", fetchSite);
  return {
    method,
    protocol,
    get(name) {
      return headers.get(String(name).toLowerCase()) || undefined;
    },
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("portal origin guard permits safe methods and same-origin browser mutations", () => {
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  enforcePortalRequestOrigin(
    requestWithHeaders({ method: "GET", origin: "https://evil.example", fetchSite: "cross-site" }),
    responseRecorder(),
    next
  );
  enforcePortalRequestOrigin(
    requestWithHeaders({
      method: "POST",
      origin: "https://clinic.example",
      fetchSite: "same-origin",
    }),
    responseRecorder(),
    next
  );

  assert.equal(nextCalls, 2);
});

test("portal origin guard rejects explicit cross-origin browser mutations", () => {
  let nextCalled = false;
  const res = responseRecorder();

  enforcePortalRequestOrigin(
    requestWithHeaders({
      method: "POST",
      origin: "https://evil.example",
      fetchSite: "cross-site",
    }),
    res,
    () => { nextCalled = true; }
  );

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body?.error || "", /cross-site|cross-origin/i);
});

test("portal origin guard permits non-browser internal mutations without Origin headers", () => {
  let nextCalled = false;
  const res = responseRecorder();

  enforcePortalRequestOrigin(
    requestWithHeaders({ method: "POST", origin: null, fetchSite: null }),
    res,
    () => { nextCalled = true; }
  );

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("createApp mounts portal security before serving traffic", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/createApp.js"),
    "utf8"
  );
  assert.match(source, /app\.disable\("x-powered-by"\)/);
  assert.match(source, /app\.use\(applyPortalSecurityHeaders\)/);
  assert.match(source, /app\.use\("\/api", enforcePortalRequestOrigin\)/);
  assert.match(
    source,
    /cookieSession\(buildPortalSessionOptions\(sessionSecret, process\.env\)\)/
  );
});
