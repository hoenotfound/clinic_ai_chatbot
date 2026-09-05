const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

function whatsappRoute() {
  const start = source.indexOf('app.post("/webhook", webhookJsonParser');
  const end = source.indexOf(
    "// ── Facebook Messenger + Instagram Messaging webhook verification",
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return source.slice(start, end);
}

test("WhatsApp delivery-status jobs are persisted before the webhook ACK", () => {
  const route = whatsappRoute();
  const parsed = route.indexOf("whatsapp.parseStatusUpdates");
  const durable = route.indexOf("storeDeliveryStatusUpdates(statusUpdates)");
  const ack = route.indexOf("res.sendStatus(200)");

  assert.ok(parsed >= 0, "delivery statuses must be parsed from the signed webhook");
  assert.ok(durable > parsed, "parsed statuses must enter durable storage");
  assert.ok(ack > durable, "HTTP 200 must wait until status jobs are persisted");
  assert.ok(route.includes("return res.sendStatus(503)"));
});

test("delivery-status side effects happen only after the durable webhook ACK", () => {
  const route = whatsappRoute();
  const ack = route.indexOf("res.sendStatus(200)");
  const process = route.indexOf("processStoredDeliveryStatuses(durableStatusJobs)");

  assert.ok(process > ack, "status application should happen after ACK once the job is durable");
  assert.equal(
    route.includes("messagesRepo.updateDeliveryStatusByWamid("),
    false,
    "webhook route must not bypass the durable status worker"
  );
});

test("startup launches delivery-status restart recovery after migrations", () => {
  const migration = source.indexOf("await initSchema()");
  const recovery = source.indexOf("startWhatsAppDeliveryStatusRecovery()");

  assert.ok(migration >= 0);
  assert.ok(recovery > migration);
});
