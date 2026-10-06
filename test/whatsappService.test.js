const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyWhatsappAcceptedResponse,
  classifyWhatsappSendFailure,
  parseIncomingMessages,
  parseReactionEvents,
  parseStatusUpdates,
  sendMessage,
  sendImageById,
  sendStickerById,
  fetchWithTimeout,
  interruptedDeliveryResult,
} = require("../src/services/whatsappService");
const whatsappPolicy = require("../src/services/whatsappPolicyService");

test("parses messages from every webhook entry and change", () => {
  const parsed = parseIncomingMessages({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6011", profile: { name: "First" } }],
              messages: [
                { id: "message-1", from: "6011", type: "text", text: { body: "Hello" } },
              ],
            },
          },
          {
            value: {
              contacts: [{ wa_id: "6012", profile: { name: "Second" } }],
              messages: [
                { id: "message-2", from: "6012", type: "image", image: { id: "image-2" } },
              ],
            },
          },
        ],
      },
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6013", profile: { name: "Third" } }],
              messages: [
                { id: "message-3", from: "6013", type: "audio", audio: { id: "audio-3" } },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parsed.map((message) => message.id), [
    "message-1",
    "message-2",
    "message-3",
  ]);
  assert.equal(parsed[1].mediaId, "image-2");
  assert.equal(parsed[2].mediaId, "audio-3");
});

test("preserves WhatsApp quoted-reply and forwarded context on inbound messages", () => {
  const [quoted, forwarded] = parseIncomingMessages({
    entry: [{
      changes: [{
        value: {
          messages: [
            {
              id: "message-reply-1",
              from: "6011",
              type: "text",
              text: { body: "This one" },
              context: { id: "wamid.original-1" },
            },
            {
              id: "message-forwarded-1",
              from: "6011",
              type: "text",
              text: { body: "Forwarded content" },
              context: { forwarded: true },
            },
          ],
        },
      }],
    }],
  });

  assert.equal(quoted.replyToProviderMessageId, "wamid.original-1");
  assert.equal(quoted.isForwarded, undefined);
  assert.equal(forwarded.replyToProviderMessageId, undefined);
  assert.equal(forwarded.isForwarded, true);
});

test("outbound WhatsApp quoted reply sends context.message_id", async (t) => {
  const originalFetch = global.fetch;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.reply-sent" }] }),
    };
  };

  const result = await sendMessage("60112223333", "Reply text", {
    replyToProviderMessageId: "wamid.original-2",
  });

  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid.reply-sent");
  assert.deepEqual(requestBody.context, { message_id: "wamid.original-2" });
  assert.equal(requestBody.text.body, "Reply text");
});

test("outbound WhatsApp sticker uses the sticker message type", async (t) => {
  const originalFetch = global.fetch;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
  });

  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-test";
  process.env.WHATSAPP_TOKEN = "token-test";
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ messages: [{ id: "wamid.sticker-sent" }] }),
    };
  };

  const result = await sendStickerById("60112223333", "media-sticker-1");

  assert.equal(result.success, true);
  assert.equal(result.wamid, "wamid.sticker-sent");
  assert.equal(requestBody.type, "sticker");
  assert.deepEqual(requestBody.sticker, { id: "media-sticker-1" });
  assert.equal(requestBody.image, undefined);
});

test("parses delivery statuses from every webhook entry and change", () => {
  const parsed = parseStatusUpdates({
    entry: [
      {
        changes: [
          { value: { statuses: [{ id: "wamid-1", status: "sent" }] } },
          { value: { statuses: [{ id: "wamid-2", status: "delivered" }] } },
        ],
      },
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: "wamid-3",
                  status: "failed",
                  errors: [{ code: 131000, title: "Failed", error_data: { details: "Rejected" } }],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parsed.map((status) => status.wamid), [
    "wamid-1",
    "wamid-2",
    "wamid-3",
  ]);
  assert.equal(parsed[2].errorMessage, "Rejected");
});

test("parses template quick-reply button taps as ordinary inbound customer text", () => {
  const parsed = parseIncomingMessages({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6014", profile: { name: "Button Customer" } }],
              messages: [
                {
                  id: "message-button-1",
                  from: "6014",
                  type: "button",
                  button: {
                    text: "Yes",
                    payload: "da_qr:lead_follow_up:0",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    id: "message-button-1",
    from: "6014",
    profileName: "Button Customer",
    text: "Yes",
    mediaId: null,
    mediaType: null,
    unsupportedType: null,
    buttonPayload: "da_qr:lead_follow_up:0",
  });
});

test("quick-reply button parser falls back to payload when Meta omits button text", () => {
  const parsed = parseIncomingMessages({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "message-button-2",
                  from: "6015",
                  type: "button",
                  button: {
                    payload: "Stop promotions",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(parsed[0].text, "Stop promotions");
  assert.equal(parsed[0].unsupportedType, null);
});

test("template opt-out quick reply reaches the existing WhatsApp opt-out classifier", () => {
  const [incoming] = parseIncomingMessages({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "message-button-stop",
                  from: "6016",
                  type: "button",
                  button: {
                    text: "Stop promotions",
                    payload: "da_qr:promo_follow_up:1",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(incoming.unsupportedType, null);
  assert.equal(whatsappPolicy.isOptOutText(incoming.text), true);
});



test("parses WhatsApp stickers as supported inbound media", () => {
  const parsed = parseIncomingMessages({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6017", profile: { name: "Sticker Customer" } }],
              messages: [
                {
                  id: "sticker-1",
                  from: "6017",
                  type: "sticker",
                  sticker: {
                    id: "media-sticker-1",
                    animated: true,
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parsed, [
    {
      id: "sticker-1",
      from: "6017",
      profileName: "Sticker Customer",
      text: null,
      mediaId: "media-sticker-1",
      mediaType: "sticker",
      unsupportedType: null,
    },
  ]);
});

test("parses WhatsApp reactions separately from conversational inbound messages", () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: "6017", profile: { name: "Reaction Customer" } }],
              messages: [
                {
                  id: "reaction-1",
                  from: "6017",
                  timestamp: "1791196800",
                  type: "reaction",
                  reaction: {
                    message_id: "wamid-target-1",
                    emoji: "❤️",
                  },
                },
                {
                  id: "message-text-after-reaction",
                  from: "6017",
                  type: "text",
                  text: { body: "Still interested" },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const incoming = parseIncomingMessages(body);
  const reactions = parseReactionEvents(body);

  assert.deepEqual(incoming.map((message) => message.id), [
    "message-text-after-reaction",
  ]);
  assert.deepEqual(reactions, [
    {
      id: "reaction-1",
      from: "6017",
      targetMessageId: "wamid-target-1",
      emoji: "❤️",
      timestamp: "1791196800",
    },
  ]);
});

test("parses WhatsApp reaction removal when Meta omits the emoji field", () => {
  const reactions = parseReactionEvents({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "reaction-remove-1",
                  from: "6018",
                  type: "reaction",
                  reaction: {
                    message_id: "wamid-target-2",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].targetMessageId, "wamid-target-2");
  assert.equal(reactions[0].emoji, "");
});

test("also accepts an explicit empty WhatsApp reaction emoji as removal", () => {
  const reactions = parseReactionEvents({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: "reaction-remove-2",
                  from: "6018",
                  type: "reaction",
                  reaction: {
                    message_id: "wamid-target-3",
                    emoji: "",
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  assert.equal(reactions.length, 1);
  assert.equal(reactions[0].targetMessageId, "wamid-target-3");
  assert.equal(reactions[0].emoji, "");
});


test("classifies Meta 131000 as a safe transient rejection", () => {
  const result = classifyWhatsappSendFailure(
    500,
    JSON.stringify({
      error: {
        code: 131000,
        message: "(#131000) Something went wrong",
        error_data: { details: "Something went wrong" },
      },
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.retryable, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.providerStatus, 500);
  assert.equal(result.providerErrorCode, 131000);
  assert.equal(result.error, "Something went wrong");
});

test("does not automatically retry an unknown generic 5xx WhatsApp rejection", () => {
  const result = classifyWhatsappSendFailure(
    521,
    JSON.stringify({ error: { message: "Provider unavailable" } })
  );

  assert.equal(result.retryable, false);
  assert.equal(result.ambiguous, false);
  assert.equal(result.providerStatus, 521);
});

test("still retries an explicit WhatsApp rate-limit rejection", () => {
  const result = classifyWhatsappSendFailure(
    429,
    JSON.stringify({ error: { message: "Too many requests" } })
  );

  assert.equal(result.retryable, true);
  assert.equal(result.ambiguous, false);
  assert.equal(result.providerStatus, 429);
});

test("does not retry a clear non-transient WhatsApp policy rejection", () => {
  const result = classifyWhatsappSendFailure(
    400,
    JSON.stringify({
      error: {
        code: 131047,
        message: "Re-engagement message",
      },
    })
  );

  assert.equal(result.retryable, false);
  assert.equal(result.ambiguous, false);
  assert.equal(result.providerErrorCode, 131047);
});


test("bounded WhatsApp fetch aborts a stalled provider request", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  global.fetch = async (_url, options = {}) =>
    await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });

  await assert.rejects(
    fetchWithTimeout("https://graph.example.test/messages", {}, 5),
    (err) => err?.name === "AbortError"
  );
});

test("interrupted WhatsApp delivery is explicitly unknown to prevent blind retry", () => {
  const timeout = new Error("aborted");
  timeout.name = "AbortError";
  const result = interruptedDeliveryResult(timeout);

  assert.equal(result.success, false);
  assert.equal(result.ambiguous, true);
  assert.equal(result.unknown, true);
  assert.equal(result.retryable, false);
  assert.match(result.error, /timed out/i);
});

test("image send timeout is persisted as unknown rather than a definite failure", async (t) => {
  const originalFetch = global.fetch;
  const oldPhone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const oldToken = process.env.WHATSAPP_TOKEN;
  const oldTimeout = process.env.WHATSAPP_MESSAGE_TIMEOUT_MS;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = oldPhone;
    if (oldToken === undefined) delete process.env.WHATSAPP_TOKEN;
    else process.env.WHATSAPP_TOKEN = oldToken;
    if (oldTimeout === undefined) delete process.env.WHATSAPP_MESSAGE_TIMEOUT_MS;
    else process.env.WHATSAPP_MESSAGE_TIMEOUT_MS = oldTimeout;
  });

  process.env.WHATSAPP_PHONE_NUMBER_ID = "phone-timeout";
  process.env.WHATSAPP_TOKEN = "token-timeout";
  process.env.WHATSAPP_MESSAGE_TIMEOUT_MS = "5";
  global.fetch = async (_url, options = {}) =>
    await new Promise((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true }
      );
    });

  const result = await sendImageById(
    "60112223333",
    "media-timeout",
    "Caption"
  );

  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.retryable, false);
});

test("requires a WhatsApp message ID before treating HTTP acceptance as confirmed", () => {
  const confirmed = classifyWhatsappAcceptedResponse({
    messages: [{ id: "wamid.confirmed" }],
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.wamid, "wamid.confirmed");
  assert.equal(confirmed.ambiguous, false);

  const unconfirmed = classifyWhatsappAcceptedResponse({ messages: [] });
  assert.equal(unconfirmed.success, false);
  assert.equal(unconfirmed.wamid, null);
  assert.equal(unconfirmed.retryable, false);
  assert.equal(unconfirmed.ambiguous, true);
  assert.equal(unconfirmed.unknown, true);
  assert.match(unconfirmed.error, /did not return a message ID/i);
});
