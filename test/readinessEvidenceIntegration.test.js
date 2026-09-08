const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("outbound readiness migration stores exact provider evidence per saved message", () => {
  const sql = read("src/db/migrations/015_outbound_message_evidence.sql");
  assert.match(sql, /message_id INTEGER PRIMARY KEY REFERENCES messages\(id\) ON DELETE CASCADE/);
  assert.match(sql, /contact_id INTEGER NOT NULL REFERENCES contacts\(id\) ON DELETE CASCADE/);
  assert.match(sql, /origin TEXT NOT NULL CHECK \(origin IN \('ai_reply', 'system_fallback'\)\)/);
  assert.match(sql, /provider_message_id TEXT/);
  assert.match(sql, /accepted_at TIMESTAMPTZ/);
});

test("normal AI replies and system fallbacks are tagged separately without delaying send completion", () => {
  const server = read("src/server.js");
  assert.match(server, /outboundMessageEvidenceRepo\.recordOutcome/);
  assert.match(server, /function sendTrackedText\(contact, text, origin = "ai_reply"\)/);
  assert.match(server, /sendResult\?\.wamid \|\| sendResult\?\.externalMessageId/);
  assert.match(server, /"system_fallback"/);
  assert.match(server, /Readiness telemetry must never become a dependency of customer delivery/);
  assert.match(server, /recordReadinessSendEvidence\(saved, contact, sendResult, origin\);/);
  assert.doesNotMatch(server, /await recordReadinessSendEvidence\(saved, contact, sendResult, origin\)/);
});

test("strict readiness query uses exact AI message evidence while operational health keeps old success metric", () => {
  const source = read("src/db/systemHealthRepo.js");
  assert.match(source, /outbound_message_evidence/);
  assert.match(source, /e\.message_id = reply\.id/);
  assert.match(source, /e\.origin = 'ai_reply'/);
  assert.match(source, /lastVerifiedAutomatedReplyAt/);
  assert.match(source, /lastSuccessfulOutboundAt: newestTimestamp/);
  assert.match(source, /runtime\.last_outbound_accepted_at/);
});

test("provisioning receipt preserves partial Render finalization instead of discarding it", () => {
  const source = read("scripts/provisionClient.js");
  assert.match(source, /if \(err\?\.partialFinalization\)/);
  assert.match(source, /\.\.\.err\.partialFinalization/);
  assert.match(source, /completed: false/);
  assert.match(source, /failureCode: err\.code \|\| "RENDER_RUNTIME_FINALIZATION_FAILED"/);
  assert.match(source, /completed: true/);
});
