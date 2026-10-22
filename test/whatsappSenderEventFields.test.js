"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const whatsapp = require("../src/services/whatsappService");
const { recordQuarantinedWhatsAppChanges } = require("../src/db/whatsappSenderQuarantineRepo");

test("passive history and state-sync fields never create inbound AI turns or receipts", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "200000000000001",
      changes: [{
        field: "history",
        value: {
          metadata: { phone_number_id: "100000000000001" },
          messages: [{ id: "wamid.false", from: "60135550000",
            type: "text", text: { body: "historical message" } }],
          statuses: [{ id: "wamid.false", status: "read" }],
        },
      }, {
        field: "smb_app_state_sync",
        value: {
          metadata: { phone_number_id: "100000000000001" },
          messages: [{ id: "wamid.false2", from: "60135550000",
            type: "reaction", reaction: { message_id: "wamid.old", emoji: "👍" } }],
        },
      }],
    }],
  };
  assert.deepEqual(whatsapp.parseIncomingMessages(payload), []);
  assert.deepEqual(whatsapp.parseReactionEvents(payload), []);
  assert.deepEqual(whatsapp.parseStatusUpdates(payload), []);
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(payload), []);
});

test("single batched quarantine query avoids serial inserts and deduplicates same-batch repeats", async () => {
  let queries = 0;
  const db = { async query(config) {
    queries++;
    assert.equal(typeof config, "object");
    assert.match(config.text, /jsonb_to_recordset/);
    assert.equal(config.query_timeout, 1500);
    const items = JSON.parse(config.values[0]);
    assert.equal(items.length, 1);
    assert.equal(items[0].fingerprint, "a".repeat(64));
    assert.equal(items[0].meta_phone_number_id, "100000000000002");
  } };
  const item = {
    fingerprint: "a".repeat(64),
    reason: "different_business_phone",
    field: "messages",
    accountId: "200000000000002",
    phoneNumberId: "100000000000002",
  };
  assert.equal(await recordQuarantinedWhatsAppChanges([item, item], db), 1);
  assert.equal(queries, 1);
});

test("quarantine audit uses an explicit maximum batch size", async () => {
  const items = Array.from({ length: 201 }, (_, i) => ({
    fingerprint: String(i).padStart(64, "0"),
    reason: "different_business_phone",
    field: "messages",
  }));
  await assert.rejects(
    recordQuarantinedWhatsAppChanges(items, { query: async () => assert.fail("query should not run") }),
    /Too many/
  );
});
