const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordOutcome,
} = require("../src/db/outboundMessageEvidenceRepo");

test("accepted readiness evidence is keyed to the exact saved message and provider ID", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [{
          message_id: params[0],
          contact_id: params[1],
          channel: params[2],
          origin: params[3],
          accepted: params[4],
          provider_message_id: params[5],
          attempted_at: params[6],
          accepted_at: params[6],
        }],
      };
    },
  };
  const attemptedAt = new Date("2026-09-08T10:00:05.000Z");

  const row = await recordOutcome({
    messageId: 77,
    contactId: 12,
    channel: "instagram",
    origin: "ai_reply",
    accepted: true,
    providerMessageId: "ig-mid-77",
    attemptedAt,
  }, queryable);

  assert.equal(row.message_id, 77);
  assert.equal(row.provider_message_id, "ig-mid-77");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(message_id\)/);
  assert.deepEqual(calls[0].params.slice(0, 6), [
    77,
    12,
    "instagram",
    "ai_reply",
    true,
    "ig-mid-77",
  ]);
});

test("failed AI send evidence remains tied to the message and has no accepted timestamp", async () => {
  let captured = null;
  const queryable = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ message_id: params[0], accepted: params[4], accepted_at: null }] };
    },
  };

  const row = await recordOutcome({
    messageId: 88,
    contactId: 19,
    channel: "facebook",
    origin: "ai_reply",
    accepted: false,
  }, queryable);

  assert.equal(row.accepted, false);
  assert.equal(row.accepted_at, null);
  assert.equal(captured.params[5], null);
});

test("accepted evidence fails closed without a provider message ID", async () => {
  let queried = false;
  await assert.rejects(
    recordOutcome({
      messageId: 99,
      contactId: 20,
      channel: "facebook",
      origin: "ai_reply",
      accepted: true,
    }, {
      async query() {
        queried = true;
        return { rows: [] };
      },
    }),
    /provider message ID/i
  );
  assert.equal(queried, false);
});

test("readiness evidence only accepts explicit AI or system-fallback origins", async () => {
  await assert.rejects(
    recordOutcome({
      messageId: 100,
      contactId: 21,
      channel: "whatsapp",
      origin: "scheduled",
      accepted: false,
    }, { async query() { return { rows: [] }; } }),
    /unsupported outbound evidence origin/i
  );
});
