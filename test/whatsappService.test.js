const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseIncomingMessages,
  parseStatusUpdates,
} = require("../src/services/whatsappService");

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
