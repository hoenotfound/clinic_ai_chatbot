const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../src/server.js"),
  "utf8"
);

test("Business App echo is marked pending before webhook durability awaits", () => {
  const webhookStart = source.indexOf('app.post("/webhook"');
  const beginIndex = source.indexOf(
    "whatsappCoexistence.beginPendingAiForEcho(echo)",
    webhookStart
  );
  const durabilityIndex = source.indexOf("await Promise.all([", webhookStart);

  assert.ok(webhookStart >= 0);
  assert.ok(beginIndex > webhookStart);
  assert.ok(durabilityIndex > beginIndex);
});

test("Business App bookkeeping completes after durable echo persistence and before webhook ACK", () => {
  const webhookStart = source.indexOf('app.post("/webhook"');
  const persistIndex = source.indexOf(
    "whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true })",
    webhookStart
  );
  const finalizeIndex = source.indexOf(
    "await whatsappCoexistence.finalizeBusinessAppEcho(persisted)",
    webhookStart
  );
  const ackIndex = source.indexOf("res.sendStatus(200)", webhookStart);

  assert.ok(persistIndex > webhookStart);
  assert.ok(finalizeIndex > persistIndex);
  assert.ok(ackIndex > finalizeIndex);
});

test("final coexistence guard runs after final ownership lookup and before tracked AI send", () => {
  const ownershipIndex = source.indexOf("const finalSendContact = flagged");
  const guardIndex = source.indexOf(
    "aiReplyCancellation.safeToSend",
    ownershipIndex
  );
  const sendIndex = source.indexOf(
    "const sendOutcome = await sendTrackedText(",
    guardIndex
  );

  assert.ok(ownershipIndex >= 0);
  assert.ok(guardIndex > ownershipIndex);
  assert.ok(sendIndex > guardIndex);
});


test("coexistence guard is opt-in and ordinary WhatsApp keeps the legacy send path", () => {
  const keyBlock = source.slice(
    source.indexOf("const aiCancellationKey ="),
    source.indexOf("const aiCancellationToken =", source.indexOf("const aiCancellationKey ="))
  );
  assert.match(
    keyBlock,
    /channel === "whatsapp" && aiReplyCancellation\.enabled\(\)/
  );
});

test("existing synthetic AI handoff acknowledgement remains sendable", () => {
  const finalContactIndex = source.indexOf("const finalSendContact = flagged");
  const guardIndex = source.indexOf(
    "aiReplyCancellation.safeToSend",
    finalContactIndex
  );

  assert.ok(finalContactIndex >= 0);
  assert.ok(guardIndex > finalContactIndex);
  const block = source.slice(finalContactIndex, guardIndex);
  assert.match(block, /flagged[\s\S]*getPendingAiHandoffContact\(contact\.id\)/);
  assert.match(block, /getAiOwnedContact\(contact/);
});
