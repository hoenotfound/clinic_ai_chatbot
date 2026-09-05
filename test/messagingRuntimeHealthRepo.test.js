const test = require("node:test");
const assert = require("node:assert/strict");

const {
  listRuntimeHealth,
  recordOutboundAccepted,
} = require("../src/db/messagingRuntimeHealthRepo");

test("social outbound health stores only channel and accepted timestamp", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const at = new Date("2026-09-05T01:00:00.000Z");

  assert.equal(await recordOutboundAccepted("instagram", at, queryable), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO messaging_runtime_health/);
  assert.match(calls[0].sql, /GREATEST/);
  assert.deepEqual(calls[0].params, ["instagram", at]);
  assert.doesNotMatch(calls[0].sql, /message|contact|recipient|token|content|provider_message_id/i);
});

test("unsupported channels are ignored without a database write", async () => {
  let queries = 0;
  const queryable = {
    async query() {
      queries += 1;
      return { rows: [] };
    },
  };

  assert.equal(await recordOutboundAccepted("whatsapp", new Date(), queryable), false);
  assert.equal(await recordOutboundAccepted("unknown", new Date(), queryable), false);
  assert.equal(queries, 0);
});

test("runtime health lists only Messenger and Instagram timestamps", async () => {
  const queryable = {
    async query(sql) {
      assert.match(sql, /WHERE channel IN \('facebook', 'instagram'\)/);
      return {
        rows: [
          { channel: "facebook", last_outbound_accepted_at: new Date("2026-09-05T01:00:00.000Z") },
          { channel: "instagram", last_outbound_accepted_at: new Date("2026-09-05T01:01:00.000Z") },
        ],
      };
    },
  };

  const rows = await listRuntimeHealth(queryable);
  assert.equal(rows.length, 2);
});
