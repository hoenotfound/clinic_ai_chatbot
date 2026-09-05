const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("AI routing telemetry is best-effort and excluded from private Setup Status checks", () => {
  const source = read("src/services/aiService.js");
  assert.match(source, /if \(options\.privateSetupCheck\) return/);
  assert.match(source, /recordRoutingEvent\(event\)\.catch/);
  assert.match(source, /eventType: "gemini_model_fallback"/);
  assert.match(source, /eventType: "claude_fallback"/);
  assert.match(source, /eventType: "ai_failure"/);
  assert.doesNotMatch(source, /await\s+aiRoutingTelemetry\.recordRoutingEvent/);
});

test("AI telemetry schema and repository do not store prompts, responses, keys or contacts", () => {
  const schema = read("src/db/migrations/012_observability_health.sql");
  const repository = read("src/db/aiRoutingTelemetryRepo.js");
  const combined = `${schema}\n${repository}`;
  assert.doesNotMatch(combined, /prompt_text|response_text|contact_id|conversation_id|api_key|access_token|credential_fingerprint/i);
});
