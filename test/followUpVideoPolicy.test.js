const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { previouslySentVideo } = require("../src/utils/followUpVideoPolicy");

test("previouslySentVideo prevents repeat media after confirmed, pending or manual sends", async () => {
  const captured = [];
  const database = {
    query: async (sql, params) => {
      captured.push({ sql, params });
      return { rows: [{ "?column?": 1 }] };
    },
  };
  assert.equal(await previouslySentVideo({
    database, contactId: 123, mediaKey: "clients/demo/video.mp4",
  }), true);
  assert.match(captured[0].sql, /role = 'assistant'/);
  assert.match(captured[0].sql, /media_key = \$2/);
  assert.match(captured[0].sql, /interval '7 days'/);
  assert.match(captured[0].sql, /delivery_status IS DISTINCT FROM 'failed'/);
  assert.match(captured[0].sql, /delivery_status IS DISTINCT FROM 'cancelled'/);
  assert.deepEqual(captured[0].params, [123, "clients/demo/video.mp4", null]);
});

test("previouslySentVideo supports excluding its own pending claim", async () => {
  const database = {
    query: async (_, params) => {
      assert.deepEqual(params, [123, "clients/demo/video.mp4", 789]);
      return { rows: [] };
    },
  };
  assert.equal(await previouslySentVideo({
    database, contactId: 123, mediaKey: "clients/demo/video.mp4", excludeMessageId: 789,
  }), false);
});

test("normal follow-up safely downgrades a duplicate or unverified video to text", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  assert.match(code, /duplicate media suppressed/);
  assert.match(code, /effectiveVideoKey = ""/);
  assert.match(code, /excludeMessageId: saved\.id/);
  assert.match(code, /if \(!eligible\) return false/);
});
