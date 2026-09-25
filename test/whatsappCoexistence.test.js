const test = require("node:test");
const assert = require("node:assert/strict");

const whatsapp = require("../src/services/whatsappService");
const aiReplyCancellation = require("../src/services/aiReplyCancellationService");
const coexistence = require("../src/services/whatsappCoexistenceService");

function echoPayload(message) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-1",
      changes: [{
        field: "smb_message_echoes",
        value: {
          metadata: {
            display_phone_number: "60122972817",
            phone_number_id: "110552088553929",
          },
          message_echoes: [message],
        },
      }],
    }],
  };
}

test("Business App text echo is parsed as outbound staff work, not customer inbound", () => {
  const body = echoPayload({
    from: "60122972817",
    to: "60135550000",
    id: "wamid.echo-1",
    timestamp: "1790320000",
    type: "text",
    text: { body: "I will help you from here." },
  });

  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), [{
    id: "wamid.echo-1",
    from: "60122972817",
    to: "60135550000",
    timestamp: "1790320000",
    type: "text",
    mediaId: null,
    text: "I will help you from here.",
  }]);
});

test("Business App echo cancellation invalidates an in-flight AI token", () => {
  const key = aiReplyCancellation.keyForWhatsAppNumber("60135550000");
  const token = aiReplyCancellation.snapshot(key);
  coexistence.cancelPendingAiForEcho({ to: "60135550000" });
  assert.equal(aiReplyCancellation.cancelledSince(key, token), true);
});

test("Cloud API message_echoes do not enter the Business App coexistence path", () => {
  const body = {
    entry: [{
      changes: [{
        field: "message_echoes",
        value: {
          message_echoes: [{
            from: "60122972817",
            to: "60135550000",
            id: "wamid.cloud-api-1",
            type: "text",
            text: { body: "API outbound" },
          }],
        },
      }],
    }],
  };
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), []);
  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
});

test("history and app-state sync are recognized without becoming AI inbound messages", () => {
  const body = {
    entry: [{
      changes: [
        {
          field: "history",
          value: {
            history: [{
              metadata: { phase: 0, chunk_order: 1, progress: 100 },
              threads: [{
                id: "60135550000",
                messages: [{
                  id: "wamid.old",
                  from: "60135550000",
                  to: "60122972817",
                  type: "text",
                  text: { body: "old customer message" },
                }],
              }],
            }],
          },
        },
        {
          field: "smb_app_state_sync",
          value: {
            state_sync: [{
              type: "contact",
              action: "add",
              contact: { full_name: "Customer", phone_number: "60135550000" },
            }],
          },
        },
      ],
    }],
  };

  assert.deepEqual(whatsapp.parseIncomingMessages(body), []);
  assert.deepEqual(whatsapp.parseBusinessAppEchoes(body), []);
  assert.deepEqual(coexistence.summarizePassiveSync(body), {
    historyChunks: 1,
    appStateItems: 1,
  });
});
