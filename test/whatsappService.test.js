const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseIncomingMessages,
  parseReactionEvents,
  parseStatusUpdates,
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
