const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const inboundProcessingRepo = require("../src/db/inboundProcessingRepo");

test("WhatsApp inbound parser preserves Meta's message timestamp", () => {
  const [incoming] = whatsapp.parseIncomingMessages({
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: "60123456789", profile: { name: "Customer" } }],
          messages: [{
            id: "wamid-source-time-1",
            from: "60123456789",
            timestamp: "1791000000",
            type: "text",
            text: { body: "Hello" },
          }],
        },
      }],
    }],
  });

  assert.equal(incoming.timestamp, "1791000000");
});

test("durable WhatsApp inbound stores Meta message time separately from persistence time", async () => {
  const incoming = {
    id: "wamid-source-time-2",
    from: "60123456789",
    channel: "whatsapp",
    timestamp: "1791000000",
    text: "Hello",
  };
  let captured = null;
  const database = {
    async query(sql, params) {
      captured = { sql, params };
      return {
        rows: [{
          saved_inbound: { id: 1, contact_id: 7, source_created_at: params[5] },
          processing_job: { id: 2, status: "pending" },
          derived_first_message: true,
        }],
      };
    },
  };

  await inboundProcessingRepo.storeInboundClaim({
    contactId: 7,
    content: "Hello",
    storedMessageId: incoming.id,
    channel: "whatsapp",
    incoming,
  }, database);

  assert.match(captured.sql, /whatsapp_message_id, source_created_at/);
  assert.match(captured.sql, /\$6::timestamptz/);
  assert.equal(
    captured.params[5],
    new Date(Number(incoming.timestamp) * 1000).toISOString()
  );
});

test("WhatsApp source time cannot extend the window into the future", () => {
  const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
  const futureTimestamp = String((nowMs + 60 * 60 * 1000) / 1000);

  assert.equal(
    inboundProcessingRepo.whatsappMessageSourceCreatedAt(
      "whatsapp",
      { timestamp: futureTimestamp },
      nowMs
    ),
    new Date(nowMs).toISOString()
  );
  assert.equal(
    inboundProcessingRepo.whatsappMessageSourceCreatedAt(
      "facebook",
      { timestamp: futureTimestamp },
      nowMs
    ),
    null
  );
  assert.equal(
    inboundProcessingRepo.whatsappMessageSourceCreatedAt(
      "whatsapp",
      { timestamp: "not-a-time" },
      nowMs
    ),
    null
  );
});
