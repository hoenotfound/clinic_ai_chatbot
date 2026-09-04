const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Setup Status leads with understandable live health signals", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.match(page, /System health/);
  assert.match(page, /Live operational signals, not just configuration checks/);
  assert.match(page, /Migration version/);
  assert.match(page, /Expected version/);
  assert.match(page, /Restart recoveries \(24h\)/);
  assert.match(page, /Final AI failures \(24h\)/);
  assert.match(page, /Gemini 2\.5 Flash-Lite/);
  assert.match(page, /Claude fallback/);
  assert.match(page, /Last successful outbound/);
  assert.match(page, /No recent inbound is not an error/);
});

test("passive no-activity warnings are separated from actionable setup problems", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.match(page, /PASSIVE_ACTIVITY_KEYS/);
  assert.match(page, /isPassiveActivityWarning/);
  assert.match(page, /Awaiting activity/);
  assert.match(page, /Nothing actionable/);
  assert.match(page, /awaiting activity/);
});

test("health UI never renders API keys or credential fingerprints", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.doesNotMatch(page, /healthKey/);
  assert.doesNotMatch(page, /credentialFingerprint/);
  assert.doesNotMatch(page, /GEMINI_API_KEY/);
  assert.doesNotMatch(page, /ANTHROPIC_API_KEY/);
});
