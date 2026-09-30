const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveTrustProxy,
  rightmostForwardedAddress,
} = require("../src/utils/proxyTrust");
const { verifyTokenMatches } = require("../src/utils/webhookVerification");

test("webhook verify tokens fail closed when either side is missing", () => {
  assert.equal(verifyTokenMatches(undefined, undefined), false);
  assert.equal(verifyTokenMatches("", "configured"), false);
  assert.equal(verifyTokenMatches("provided", ""), false);
  assert.equal(verifyTokenMatches(["configured"], "configured"), false);
});

test("webhook verify tokens use a constant-time digest comparison", () => {
  assert.equal(verifyTokenMatches("same-secret", "same-secret"), true);
  assert.equal(verifyTokenMatches("wrong-secret", "same-secret"), false);
});

test("Render trusts exactly one proxy hop by default", () => {
  assert.equal(resolveTrustProxy({ RENDER: "true" }), 1);
  assert.equal(resolveTrustProxy({}), false);
  assert.equal(resolveTrustProxy({ TRUST_PROXY_HOPS: "2" }), 2);
  assert.equal(resolveTrustProxy({ TRUST_PROXY_HOPS: "0" }), false);
  assert.throws(
    () => resolveTrustProxy({ TRUST_PROXY_HOPS: "all" }),
    /TRUST_PROXY_HOPS/
  );
});

test("forwarded-address fallback selects the proxy-appended rightmost value", () => {
  assert.equal(
    rightmostForwardedAddress("198.51.100.99, 203.0.113.8"),
    "203.0.113.8"
  );
  assert.equal(rightmostForwardedAddress("203.0.113.8"), "203.0.113.8");
  assert.equal(rightmostForwardedAddress(""), null);
});
