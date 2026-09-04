const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("auth route awaits persistent failure recording and replaces pre-auth session state", () => {
  const auth = source("src/routes/auth.js");
  assert.match(auth, /await recordFailedAttempt\(req\)/);
  assert.match(auth, /await verifyLoginCredentials\(user, password\)/);
  assert.match(auth, /req\.session = \{[\s\S]*userId:[\s\S]*username:[\s\S]*authVersion:/);
  assert.match(auth, /req\.sessionOptions\.secure = true/);
  assert.match(auth, /Cache-Control", "no-store"/);
});

test("login limiter is persistent and no longer uses an in-memory attempt map", () => {
  const limiter = source("src/middleware/loginRateLimit.js");
  assert.match(limiter, /loginRateLimitRepo/);
  assert.doesNotMatch(limiter, /const attempts = new Map\(/);
  assert.match(limiter, /pair: 8/);
  assert.match(limiter, /username: 15/);
  assert.match(limiter, /ip: 40/);
});

test("startup migrations include persistent login throttling table", () => {
  const db = source("src/db/db.js");
  const runner = source("src/db/migrationRunner.js");
  const schema = source("src/db/loginRateLimitSchema.sql");

  assert.match(db, /runMigrations\(pool\)/);
  assert.match(runner, /name: "login_rate_limits"/);
  assert.match(runner, /file: "loginRateLimitSchema\.sql"/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS login_rate_limits/);
  assert.match(schema, /PRIMARY KEY \(scope, key_hash\)/);
});