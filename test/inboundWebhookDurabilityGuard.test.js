const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../src/server.js"),
  "utf8"
);

function routeBody(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing route end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("WhatsApp persists inbound jobs before returning HTTP 200", () => {
  const route = routeBody(
    'app.post("/webhook", webhookJsonParser',
    "// ── Facebook Messenger + Instagram Messaging webhook verification"
  );
  const durable = route.indexOf("await durablyClaimIncoming");
  const ack = route.indexOf("res.sendStatus(200)");

  assert.ok(durable >= 0, "WhatsApp route must durably claim inbound messages");
  assert.ok(ack > durable, "WhatsApp ACK must happen after durable message/job persistence");
  assert.ok(route.includes("return res.sendStatus(503)"));
});

test("standard Messenger/Instagram messages persist before returning HTTP 200", () => {
  const route = routeBody(
    'app.post("/meta-webhook", metaWebhookJsonParser',
    "// ── Promo graphics uploaded from Settings"
  );
  const durable = route.indexOf("await durablyClaimIncoming");
  const ack = route.indexOf("res.sendStatus(200)");

  assert.ok(durable >= 0, "Meta route must durably claim standard inbound messages");
  assert.ok(ack > durable, "Meta ACK must happen after durable standard-message persistence");
  assert.ok(route.includes("return res.sendStatus(503)"));
});

test("AI/media work remains after webhook acknowledgement", () => {
  const whatsappRoute = routeBody(
    'app.post("/webhook", webhookJsonParser',
    "// ── Facebook Messenger + Instagram Messaging webhook verification"
  );
  const metaRoute = routeBody(
    'app.post("/meta-webhook", metaWebhookJsonParser',
    "// ── Promo graphics uploaded from Settings"
  );

  assert.ok(
    whatsappRoute.indexOf("scheduleDurableClaim") > whatsappRoute.indexOf("res.sendStatus(200)"),
    "WhatsApp reply processing must remain after the ACK"
  );
  assert.ok(
    metaRoute.indexOf("scheduleDurableClaim") > metaRoute.indexOf("res.sendStatus(200)"),
    "Meta reply processing must remain after the ACK"
  );
});
