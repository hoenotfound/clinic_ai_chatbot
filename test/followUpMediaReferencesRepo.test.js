const test = require("node:test");
const assert = require("node:assert/strict");
const { listReferencedFollowUpConfigVideoKeys } = require("../src/db/followUpMediaReferencesRepo");

test("cleanup reference lookup includes historical Inbox follow-up video keys", async () => {
  const keys = await listReferencedFollowUpConfigVideoKeys({
    database: {
      async query(sql) {
        assert.match(sql, /SELECT DISTINCT media_key/);
        assert.match(sql, /FROM messages/);
        assert.match(sql, /messages\/follow-up-config/);
        return {
          rows: [
            { media_key: "clients/neutro/messages/follow-up-config/old.mp4" },
            { media_key: "messages/follow-up-config/legacy.mp4" },
          ],
        };
      },
    },
  });
  assert.deepEqual(keys, [
    "clients/neutro/messages/follow-up-config/old.mp4",
    "messages/follow-up-config/legacy.mp4",
  ]);
});

test("cleanup reference lookup must fail closed if Neon is unavailable", async () => {
  await assert.rejects(
    listReferencedFollowUpConfigVideoKeys({
      database: { query: async () => { throw new Error("database unavailable"); } },
    }),
    /database unavailable/
  );
});
