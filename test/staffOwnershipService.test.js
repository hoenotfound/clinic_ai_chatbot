const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createStaffOwnershipService,
} = require("../src/services/staffOwnershipService");
const { AI_HANDOFF_OWNER } = require("../src/services/aiHandoffService");

test("first staff reply claims a synthetic AI handoff without changing Staff mode", async () => {
  const calls = [];
  const published = [];
  const claim = createStaffOwnershipService({
    database: {
      async query(sql, params) {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        return { rows: [{ id: 42, mode: "human", takeover_by: "caden" }] };
      },
    },
    publish(type, payload) { published.push({ type, payload }); },
  });

  const result = await claim(42, "caden");
  assert.equal(result.takeover_by, "caden");
  assert.match(calls[0].sql, /mode = 'human'/);
  assert.match(calls[0].sql, /takeover_by = \$3/);
  assert.deepEqual(calls[0].params, ["caden", 42, AI_HANDOFF_OWNER]);
  assert.equal(published[0].payload.reason, "staff_claimed_ai_handoff");
});
