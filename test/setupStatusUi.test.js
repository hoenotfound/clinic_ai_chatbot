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
  assert.match(page, /Credentials remain on the server/);
  assert.match(page, /never message customers/);
  assert.match(page, /Run all checks/);
  assert.match(page, /w-full.*sm:w-auto/);
  assert.match(page, /sm:grid-cols-2/);
  assert.match(page, /safe-area-inset-bottom/);
  assert.match(page, /About Meta app review/);
  assert.match(page, /cannot confirm that Meta has approved public messaging access/);
  assert.match(page, /<details/);
  assert.match(page, /View AI key health/);
  assert.match(page, /Fallback keys are only checked when earlier keys cannot complete a reply/);
  assert.match(page, /Last rate limited/);
});

test("setup status uses clear historical AI labels and accessible mobile controls", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.match(page, /Succeeded last attempt/);
  assert.match(page, /Rate limited last attempt/);
  assert.match(page, /Credentials rejected/);
  assert.match(page, /Needs attention/);
  assert.match(page, /Optional not set up/);
  assert.match(page, /min-h-11/);
  assert.match(page, /focus-visible:ring-2/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /aria-busy=\{running\}/);
  assert.doesNotMatch(page, /text-\[(?:8|9)px\]/);
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
  const repository = read("src/db/setupStatusRepo.js");
  assert.match(server, /recordWebhook\("whatsapp_webhook"\)/);
  assert.match(server, /Promise\.all\(\[incomingWork, webhookActivity\]\)/);
  assert.doesNotMatch(server, /recordWebhook\("whatsapp"\)/);
  assert.match(repository, /listLatestInboundActivity/);
  assert.match(repository, /m\.role = 'user'/);
});
