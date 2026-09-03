const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("scheduled-message window returns the latest inbound timestamp without a ReferenceError", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/scheduledMessageBootstrap.js"),
    "utf8"
  );
  const match = source.match(/function schedulePolicy\(contact, latestInboundAt\) \{[\s\S]*?\n\}\n\nasync function buildWindow\(contact\) \{[\s\S]*?\n\}/);
  assert.ok(match, "Could not locate buildWindow in scheduledMessageBootstrap.js");

  const latestInboundAt = new Date("2026-09-03T02:00:00.000Z");
  const windowEndsAt = new Date("2026-09-04T02:00:00.000Z");
  const scheduledRepo = {
    async getLatestInboundAt(contactId) {
      assert.equal(contactId, 42);
      return latestInboundAt;
    },
  };
  const whatsappPolicy = {
    evaluateFreeformState(state) {
      assert.equal(state.id, 42);
      assert.equal(state.latest_inbound_at, latestInboundAt);
      return { allowed: true, code: null, message: null };
    },
  };
  const scheduleValidation = ({ lastInboundAt }) => {
    assert.equal(lastInboundAt, latestInboundAt);
    return { windowEndsAt };
  };

  const buildWindow = new Function(
    "scheduledRepo",
    "scheduleValidation",
    "whatsappPolicy",
    `${match[0]}; return buildWindow;`
  )(scheduledRepo, scheduleValidation, whatsappPolicy);

  const result = await buildWindow({ id: 42, channel: "whatsapp" });
  assert.equal(result.lastInboundAt, latestInboundAt);
  assert.equal(result.windowEndsAt, windowEndsAt);
  assert.equal(result.policy.allowed, true);
});
