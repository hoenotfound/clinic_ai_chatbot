const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("client ops readiness endpoint is machine-token protected and bypasses user-session auth", () => {
  const server = source("src/server.js");
  assert.match(server, /app\.use\("\/api\/ops\/readiness", opsReadinessRoutes\)/);
  const opsIndex = server.indexOf('app.use("/api/ops/readiness", opsReadinessRoutes)');
  const managementIndex = server.indexOf('app.use("/api/auth", authRoutes)');
  assert.equal(opsIndex >= 0 && managementIndex >= 0 && opsIndex < managementIndex, true);
});

test("ops readiness sanitizer does not import customer repositories", () => {
  const service = source("src/services/opsReadinessService.js");
  assert.doesNotMatch(service, /contactsRepo|messagesRepo|pipelineRepo|conversationStore/);
  assert.match(service, /sanitizeGateForOps/);
});

test("central registry uses OPS_DATABASE_URL instead of client DATABASE_URL", () => {
  const db = source("src/ops/db.js");
  assert.match(db, /OPS_DATABASE_URL/);
  assert.doesNotMatch(db, /process\.env\.DATABASE_URL/);
});

test("registry stores token environment names rather than token values", () => {
  const repo = source("src/ops/clientRegistryRepo.js");
  assert.match(repo, /token_env_key/);
  assert.doesNotMatch(repo, /token_cipher|token_value|admin_password|database_url/);
});
