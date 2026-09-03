const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("setup status is admin-only in both portal routing and server routing", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const route = read("src/routes/setupStatus.js");

  assert.match(app, /path="\/setup"/);
  assert.match(app, /adminOnly/);
  assert.match(sidebar, /user\?\.role === "admin"/);
  assert.match(route, /req\.user\?\.role !== "admin"/);
});

test("setup status UI includes private-credential copy and responsive controls", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.match(page, /Credentials stay private/);
  assert.match(page, /never returned to this page/);
  assert.match(page, /Run all checks/);
  assert.match(page, /w-full.*sm:w-auto/);
  assert.match(page, /sm:grid-cols-2/);
  assert.match(page, /safe-area-inset-bottom/);
  assert.match(page, /Meta app review is separate/);
  assert.match(page, /cannot confirm that Meta has approved public messaging access/);
  assert.match(page, /<details/);
  assert.match(page, /View AI key health/);
  assert.match(page, /Key values are never displayed/);
  assert.match(page, /Last rate limited/);
});

test("legacy public Instagram diagnostic routes were removed", () => {
  const server = read("src/server.js");
  assert.doesNotMatch(server, /debug-instagram-token/);
  assert.doesNotMatch(server, /debug-instagram-conversations/);
});

test("setup schema is included in startup and stores no credentials", () => {
  const db = read("src/db/db.js");
  const schema = read("src/db/setupStatusSchema.sql");
  assert.match(db, /setupStatusSchema\.sql/);
  assert.match(schema, /last_success_at/);
  assert.match(schema, /last_webhook_at/);
  assert.match(schema, /setup_ai_candidate_health/);
  assert.match(schema, /last_rate_limited_at/);
  assert.doesNotMatch(schema, /access_token|api_key|password/i);
});

test("WhatsApp webhook activity updates the dedicated webhook check", () => {
  const server = read("src/server.js");
  assert.match(server, /recordWebhook\("whatsapp_webhook"\)/);
  assert.doesNotMatch(server, /recordWebhook\("whatsapp"\)/);
});
