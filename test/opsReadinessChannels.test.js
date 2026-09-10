const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeChannels } = require("../src/services/opsReadinessService");

test("Facebook and Instagram stay independent when both are purchased", () => {
  const channels = sanitizeChannels([
    { channel: "facebook", purchased: true, ready: true, verificationState: "ready" },
    { channel: "instagram", purchased: true, ready: false, verificationState: "needs_testing" },
  ]);

  assert.deepEqual(channels.map((item) => item.channel), ["facebook", "instagram"]);
  assert.equal(channels[0].ready, true);
  assert.equal(channels[1].ready, false);
});

test("unpurchased channels are omitted from the machine readiness projection", () => {
  const channels = sanitizeChannels([
    { channel: "whatsapp", purchased: true, ready: true },
    { channel: "facebook", purchased: false, ready: false },
    { channel: "instagram", purchased: false, ready: false },
  ]);

  assert.deepEqual(channels.map((item) => item.channel), ["whatsapp"]);
});
