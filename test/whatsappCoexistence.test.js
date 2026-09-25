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


test("in-flight AI settle guard suppresses send when a Business App echo arrives", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  process.env.WHATSAPP_COEXISTENCE_ENABLED = "true";
  try {
    const key = aiReplyCancellation.keyForWhatsAppNumber("60137770000");
    const token = aiReplyCancellation.snapshot(key);
    const guarded = aiReplyCancellation.settleBeforeSend(key, token, {
      delayMs: 25,
      pendingWaitMs: 100,
      pollMs: 5,
    });
    setTimeout(() => aiReplyCancellation.cancel(key), 5);
    assert.equal(await guarded, false);
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});

test("non-coexistence clients keep the existing reply path without settle delay", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
  try {
    const key = aiReplyCancellation.keyForWhatsAppNumber("60138880000");
    const token = aiReplyCancellation.snapshot(key);
    aiReplyCancellation.cancel(key);
    assert.equal(
      await aiReplyCancellation.settleBeforeSend(key, token, {
        delayMs: 1000,
        pendingWaitMs: 1000,
      }),
      true
    );
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});


test("pending Business App echo blocks AI before durable persistence finishes", async () => {
  const previous = process.env.WHATSAPP_COEXISTENCE_ENABLED;
  process.env.WHATSAPP_COEXISTENCE_ENABLED = "true";
  try {
    const echo = { id: "wamid.pending-1", to: "60139990000" };
    const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to);
    const token = aiReplyCancellation.snapshot(key);

    coexistence.beginPendingAiForEcho(echo);
    assert.equal(aiReplyCancellation.safeToSend(key, token), false);

    const guarded = aiReplyCancellation.settleBeforeSend(key, token, {
      delayMs: 1,
      pendingWaitMs: 20,
      pollMs: 2,
    });
    assert.equal(await guarded, false);

    coexistence.releasePendingAiForEcho(echo);
    assert.equal(aiReplyCancellation.safeToSend(key, token), true);
  } finally {
    if (previous == null) delete process.env.WHATSAPP_COEXISTENCE_ENABLED;
    else process.env.WHATSAPP_COEXISTENCE_ENABLED = previous;
  }
});

test("duplicate echo can be released without permanently cancelling a later AI turn", () => {
  const echo = { id: "wamid.duplicate-1", to: "60131112222" };
  const key = aiReplyCancellation.keyForWhatsAppNumber(echo.to);
  const token = aiReplyCancellation.snapshot(key);

  coexistence.beginPendingAiForEcho(echo);
  assert.equal(aiReplyCancellation.safeToSend(key, token), false);
  coexistence.releasePendingAiForEcho(echo);

  assert.equal(aiReplyCancellation.safeToSend(key, token), true);
});
