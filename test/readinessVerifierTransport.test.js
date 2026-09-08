const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ClientReadinessError,
  DEFAULT_READINESS_TIMEOUT_MS,
  normalizeBaseUrl,
} = require("../src/provisioning/readinessVerifier");

test("remote readiness verification requires HTTPS before admin credentials can be sent", () => {
  assert.equal(normalizeBaseUrl("https://client.example/"), "https://client.example");
  assert.equal(normalizeBaseUrl("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");

  assert.throws(
    () => normalizeBaseUrl("http://client.example"),
    (err) => err instanceof ClientReadinessError && err.code === "READINESS_HTTPS_REQUIRED"
  );
});

test("readiness outer request timeout allows the existing parallel Setup Status checks to finish", () => {
  assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 60000);
});
