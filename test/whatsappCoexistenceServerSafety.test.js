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

test("Business App pipeline/realtime bookkeeping happens only after webhook ACK", () => {
  const webhookStart = source.indexOf('app.post("/webhook"');
  const ackIndex = source.indexOf("res.sendStatus(200)", webhookStart);
  const finalizeIndex = source.indexOf(
    "whatsappCoexistence.finalizeBusinessAppEcho(persisted)",
    webhookStart
  );

  assert.ok(ackIndex > webhookStart);
  assert.ok(finalizeIndex > ackIndex);
});

test("final coexistence guard runs after final ownership lookup and before tracked AI send", () => {
  const aiBlock = source.indexOf('reason: "AI provider send"');
  const ownershipIndex = source.lastIndexOf(
    "const finalAiContact = await getAiOwnedContact",
    aiBlock
  );
  const guardIndex = source.indexOf(
    "aiReplyCancellation.safeToSend",
    aiBlock
  );
  const sendIndex = source.indexOf(
    "const sendOutcome = await sendTrackedText(contact, reply)",
    aiBlock
  );

  assert.ok(ownershipIndex >= 0);
  assert.ok(guardIndex > aiBlock);
  assert.ok(sendIndex > guardIndex);
});
