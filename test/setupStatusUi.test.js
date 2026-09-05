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
  assert.match(page, /model metadata only/);
  assert.match(page, /Run all checks/);
  assert.match(page, /w-full.*sm:w-auto/);
  assert.match(page, /sm:grid-cols-2/);
  assert.match(page, /safe-area-inset-bottom/);
  assert.match(page, /About Meta app review/);
  assert.match(page, /cannot confirm that Meta has approved public messaging access/);
  assert.match(page, /<details/);
  assert.match(page, /View AI key checks/);
  assert.match(page, /Run all checks refreshes every configured Gemini key/);
  assert.match(page, /does not generate AI text or consume prompt\/output tokens/);
  assert.match(page, /Runtime history comes from real AI traffic and is kept separately/);
  assert.match(page, /Last setup check/);
  assert.match(page, /Last runtime attempt/);
  assert.match(page, /Last rate limited/);
  assert.match(page, /Awaiting activity/);
  assert.match(page, /Latest customer message/);
});

test("setup status keeps metadata checks distinct from historical AI runtime labels", () => {
  const page = read("portal-frontend/src/pages/SetupStatus.jsx");
  assert.match(page, /Accessible/);
  assert.match(page, /Metadata rate limited/);
  assert.match(page, /Metadata unavailable/);
  assert.match(page, /Runtime history/);
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

test("setup schema is included in startup migrations and stores no credentials", () => {
  const db = read("src/db/db.js");
  const runner = read("src/db/migrationRunner.js");
  const schema = read("src/db/setupStatusSchema.sql");

  assert.match(db, /runMigrations\(pool\)/);
  assert.match(runner, /name: "setup_status"/);
  assert.match(runner, /file: "setupStatusSchema\.sql"/);
  assert.match(schema, /last_success_at/);
  assert.match(schema, /last_webhook_at/);
  assert.match(schema, /setup_ai_candidate_health/);
  assert.match(schema, /setup_ai_candidate_checks/);
  assert.match(schema, /last_rate_limited_at/);
  assert.doesNotMatch(schema, /access_token|api_key|password/i);
});

test("WhatsApp webhook activity is recorded without delaying the durable ACK", () => {
  const server = read("src/server.js");
  const repository = read("src/db/setupStatusRepo.js");

  const handlerStart = server.indexOf('app.post("/webhook"');
  const handlerEnd = server.indexOf('app.get("/meta-webhook"', handlerStart);
  assert.ok(handlerStart >= 0, "WhatsApp webhook handler should exist");
  assert.ok(handlerEnd > handlerStart, "WhatsApp webhook handler should have a bounded source section");

  const handler = server.slice(handlerStart, handlerEnd);
  const durableInboundIndex = handler.indexOf("durablyClaimIncoming(incoming.from, incoming)");
  const durableStatusIndex = handler.indexOf("storeDeliveryStatusUpdates(statusUpdates)");
  const ackIndex = handler.indexOf("res.sendStatus(200);");
  const webhookActivityIndex = handler.indexOf('setupStatusRepo.recordWebhook("whatsapp_webhook")');
  const scheduleIndex = handler.indexOf("scheduleDurableClaim(queueKey, durableClaim)");
  const statusProcessIndex = handler.indexOf("processStoredDeliveryStatuses(durableStatusJobs)");

  assert.ok(durableInboundIndex >= 0, "inbound messages should be durably claimed before ACK");
  assert.ok(durableStatusIndex >= 0, "delivery statuses should be durably stored before ACK");
  assert.ok(
    ackIndex > durableInboundIndex && ackIndex > durableStatusIndex,
    "HTTP 200 must wait for durable inbound and delivery-status persistence"
  );
  assert.ok(
    webhookActivityIndex > ackIndex,
    "setup-status bookkeeping must run after HTTP 200 so it cannot delay Meta acknowledgement"
  );
  assert.ok(
    scheduleIndex > ackIndex,
    "AI/media processing must remain after HTTP 200"
  );
  assert.ok(
    statusProcessIndex > ackIndex,
    "delivery-status side effects must run only after the callback is durable and Meta has been ACKed"
  );
  assert.match(handler, /recordWebhook\("whatsapp_webhook"\)\.catch\(/);
  assert.doesNotMatch(handler, /await\s+setupStatusRepo\.recordWebhook\("whatsapp_webhook"\)/);
  assert.doesNotMatch(server, /recordWebhook\("whatsapp"\)/);
  assert.match(repository, /listLatestInboundActivity/);
  assert.match(repository, /m\.role = 'user'/);
});