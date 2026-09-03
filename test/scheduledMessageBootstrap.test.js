const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("scheduled-message window returns the latest inbound timestamp without a ReferenceError", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/services/scheduledMessageBootstrap.js"),
    "utf8"
  );
  const match = source.match(/async function buildWindow\(contactId\) \{[\s\S]*?\n\}/);
  assert.ok(match, "Could not locate buildWindow in scheduledMessageBootstrap.js");

  const latestInboundAt = new Date("2026-09-03T02:00:00.000Z");
  const windowEndsAt = new Date("2026-09-04T02:00:00.000Z");
  const scheduledRepo = {
    async getLatestInboundAt(contactId) {
      assert.equal(contactId, 42);
      return latestInboundAt;
    },
  };
  const scheduleValidation = ({ lastInboundAt }) => {
    assert.equal(lastInboundAt, latestInboundAt);
    return { windowEndsAt };
  };

  const buildWindow = new Function(
    "scheduledRepo",
    "scheduleValidation",
    `${match[0]}; return buildWindow;`
  )(scheduledRepo, scheduleValidation);

  const result = await buildWindow(42);
  assert.equal(result.lastInboundAt, latestInboundAt);
  assert.equal(result.windowEndsAt, windowEndsAt);
});
