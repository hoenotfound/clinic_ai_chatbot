"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isKnownPortalRoute, createUnknownPathLimiter, createPortalFallback,
} = require("../src/utils/portalFallbackGuard");

test("SPA allowlist exactly covers the client router's named public paths", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "../portal-frontend/src/App.jsx"), "utf8"
  );
  for (const [, route] of appSource.matchAll(/\bpath="(\/[^"]+)"/g)) {
    assert.equal(isKnownPortalRoute(route), true, route + " must remain deep-linkable");
  }
  for (const route of ["/inbox/", "/LOGIN", "/settings/advanced-config"]) {
    assert.equal(isKnownPortalRoute(route), true, route);
  }
  for (const route of [
    "/", "/health/not-ready", "/meta-webhook", "/webhook", "/whatsapp/default",
    "/api/conversations", "/promo-images/4", "/wp-admin", "/.env",
    "/inbox/hidden", "/admin", "/forgotten",
  ]) {
    assert.equal(isKnownPortalRoute(route), false, route);
  }
});

test("unknown route limiter is per source, bounded and expires", () => {
  let time = 1000;
  const limiter = createUnknownPathLimiter({
    now: () => time, windowMs: 1000, maxRequests: 2,
    maxEntries: 2, salt: Buffer.alloc(32),
  });
  assert.equal(limiter("sourceA").limited, false);
  assert.equal(limiter("sourceA").limited, false);
  assert.equal(limiter("sourceA").limited, true);
  assert.equal(limiter("sourceA").retryAfterSeconds, 1);
  assert.equal(limiter("sourceB").limited, false);
  assert.equal(limiter("sourceC").limited, false); // bounded eviction
  time = 2000;
  assert.equal(limiter("sourceA").limited, false);
});

function responseRecorder() {
  return {
    statusCode: 200, headers: {},
    status(code) { this.statusCode = code; return this; },
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; return this; },
    sendFile(file, callback) { this.file = file; this.callback = callback; return this; },
    end() { this.ended = true; return this; },
  };
}

test("known deep links load the SPA; invalid paths never send portal HTML", () => {
  let limiterCalls = 0;
  const handler = createPortalFallback("/tmp/test-portal-dist", {
    limiter: () => { limiterCalls++; return { limited: false, retryAfterSeconds: 300 }; },
  });
  for (const route of ["/login", "/inbox", "/settings/team", "/tools/lead-distribution"]) {
    const res = responseRecorder();
    handler({ path: route, ip: "client" }, res);
    assert.equal(res.file, path.join("/tmp/test-portal-dist", "index.html"));
    assert.equal(limiterCalls, 0);
  }
  for (const route of ["/health/hidden", "/wp-admin", "/missing.js", "/unknown"]) {
    const res = responseRecorder();
    handler({ path: route, ip: "bot" }, res);
    assert.equal(res.file, undefined);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body, "Not found.");
    assert.equal(res.contentType, "text/plain");
  }
  assert.equal(limiterCalls, 4);
});

test("repeated invalid requests return a small 429 with Retry-After", () => {
  const handler = createPortalFallback("/tmp/test-portal-dist", {
    limiter: createUnknownPathLimiter({
      maxRequests: 1, salt: Buffer.alloc(32),
    }),
  });
  const first = responseRecorder();
  handler({ path: "/bad", ip: "bot" }, first);
  assert.equal(first.statusCode, 404);

  const throttled = responseRecorder();
  handler({ path: "/bad-again", ip: "bot" }, throttled);
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.contentType, "text/plain");
  assert.equal(throttled.body, "Too many invalid requests.");
  assert.ok(Number(throttled.headers["retry-after"]) > 0);

  const legitimate = responseRecorder();
  handler({ path: "/inbox", ip: "bot" }, legitimate);
  assert.match(legitimate.file, /index\.html$/);
  assert.equal(legitimate.statusCode, 200);
});
