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

test("durable WhatsApp inbound uses Meta message time as messages.created_at", async () => {
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
          saved_inbound: { id: 1, contact_id: 7, created_at: params[5] },
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

  assert.match(captured.sql, /whatsapp_message_id, created_at/);
  assert.match(captured.sql, /COALESCE\(\$6::timestamptz, NOW\(\)\)/);
  assert.equal(
    captured.params[5],
    new Date(Number(incoming.timestamp) * 1000).toISOString()
  );
});

test("WhatsApp source time cannot extend the window into the future", () => {
  const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
  const futureTimestamp = String((nowMs + 60 * 60 * 1000) / 1000);

  assert.equal(
    inboundProcessingRepo.whatsappMessageCreatedAt(
      "whatsapp",
      { timestamp: futureTimestamp },
      nowMs
    ),
    new Date(nowMs).toISOString()
  );
  assert.equal(
    inboundProcessingRepo.whatsappMessageCreatedAt(
      "facebook",
      { timestamp: futureTimestamp },
      nowMs
    ),
    null
  );
  assert.equal(
    inboundProcessingRepo.whatsappMessageCreatedAt(
      "whatsapp",
      { timestamp: "not-a-time" },
      nowMs
    ),
    null
  );
});
