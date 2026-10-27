"use strict";

// Fast, no-network regression test for the manual PR395 relay rehearsal guard.
// It deliberately does NOT load the PR395 relay, connect any receiver, or
// supply secrets. Catches undefined identifier failures like PINN vs PINNED
// that a syntax-only check misses.
const test = require("node:test");
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const path = require("node:path");

const harness = path.resolve(__dirname, "../scripts/qa/pr395LocalRelayRehearsal.cjs");
const pinned = "19b1bbe00b18e28fb90cdf5755c9ac8ac49484ca";

for (const [name, overrides] of [
  ["missing PR source", {PR395_RELAY_SOURCE: ""}],
  ["incorrect approved SHA", {PR395_APPROVED_SHA: "0000000000000000000000000000000000000000"}],
  ["non-main branch", {GITHUB_REF: "refs/heads/untrusted"}],
  ["non-manual trigger", {GITHUB_EVENT_NAME: "pull_request"}],
]) {
  test("PR395 rehearsal fails closed for " + name + " without ReferenceError", () => {
    const env = {
      ...process.env,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      PR395_APPROVED_SHA: pinned,
      RUNNER_TEMP: "/tmp/pr395-guard-regression-only",
      // A syntactically valid temporary source path; all invalid preflight
      // cases must be rejected before attempting require() or I/O.
      PR395_RELAY_SOURCE: "/tmp/pr395-guard-regression-only/fake-relay.js",
      ...overrides,
    };
    const result = spawnSync(process.execPath, [harness], {
      env, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /NO-GO: main-only approved SHA and temporary source are required/);
    assert.doesNotMatch(result.stderr, /ReferenceError|TypeError/);
  });
}
