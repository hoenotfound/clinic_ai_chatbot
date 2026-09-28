const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(
  path.join(__dirname, "../src/server.js"),
  "utf8"
);
const appSource = fs.readFileSync(
  path.join(__dirname, "../src/createApp.js"),
  "utf8"
);

test("Business App echo is marked pending before webhook durability awaits", () => {
  const webhookStart = appSource.indexOf('app.post("/webhook"');
  const beginIndex = appSource.indexOf(
    "whatsappCoexistence.beginPendingAiForEcho(echo)",
    webhookStart
  );
  const durabilityIndex = appSource.indexOf("await Promise.all([", webhookStart);

  assert.ok(webhookStart >= 0);
  assert.ok(beginIndex > webhookStart);
  assert.ok(durabilityIndex > beginIndex);
});

test("Business App bookkeeping completes after durable echo persistence and before webhook ACK", () => {
  const webhookStart = appSource.indexOf('app.post("/webhook"');
  const persistIndex = appSource.indexOf(
    "whatsappCoexistence.persistBusinessAppEcho(echo, { pendingStarted: true })",
    webhookStart
  );
  const finalizeIndex = appSource.indexOf(
    "await whatsappCoexistence.finalizeBusinessAppEcho(persisted)",
    webhookStart
  );
  const ackIndex = appSource.indexOf("res.sendStatus(200)", webhookStart);

  assert.ok(persistIndex > webhookStart);
  assert.ok(finalizeIndex > persistIndex);
  assert.ok(ackIndex > finalizeIndex);
});

test("final coexistence guard runs after final ownership lookup and before tracked AI send", () => {
  const ownershipIndex = serverSource.indexOf("const finalSendContact = flagged");
  const guardIndex = serverSource.indexOf(
    "aiReplyCancellation.safeToSend",
    ownershipIndex
  );
  const sendIndex = serverSource.indexOf(
    "const sendOutcome = await sendTrackedText(",
    guardIndex
  );

  assert.ok(ownershipIndex >= 0);
  assert.ok(guardIndex > ownershipIndex);
  assert.ok(sendIndex > guardIndex);
});


test("coexistence guard is opt-in and ordinary WhatsApp keeps the legacy send path", () => {
  const keyStart = serverSource.indexOf("const aiCancellationKey =");
  const keyBlock = serverSource.slice(
    keyStart,
    serverSource.indexOf("const aiCancellationToken =", keyStart)
  );
  assert.match(
    keyBlock,
    /channel === "whatsapp" && aiReplyCancellation\.enabled\(\)/
  );
});

test("existing synthetic AI handoff acknowledgement remains sendable", () => {
  const finalContactIndex = serverSource.indexOf("const finalSendContact = flagged");
  const guardIndex = serverSource.indexOf(
    "aiReplyCancellation.safeToSend",
    finalContactIndex
  );

  assert.ok(finalContactIndex >= 0);
  assert.ok(guardIndex > finalContactIndex);
  const block = serverSource.slice(finalContactIndex, guardIndex);
  assert.match(block, /flagged[\s\S]*getPendingAiHandoffContact\(contact\.id\)/);
  assert.match(block, /getAiOwnedContact\(contact/);
});
