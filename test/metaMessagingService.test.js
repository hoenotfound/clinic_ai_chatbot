const test = require("node:test");
const assert = require("node:assert/strict");

const meta = require("../src/services/metaMessagingService");

test("parses Facebook Messenger text messages and skips outgoing echoes", () => {
  const parsed = meta.parseIncomingMessages({
    object: "page",
    entry: [
      {
        id: "page-1",
        messaging: [
          {
            sender: { id: "psid-1" },
            recipient: { id: "page-1" },
            message: { mid: "fb-mid-1", text: "Hello from Facebook" },
          },
          {
            sender: { id: "page-1" },
            recipient: { id: "psid-1" },
            message: { mid: "fb-echo-1", text: "Our reply", is_echo: true },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    id: "fb-mid-1",
    from: "psid-1",
    channel: "facebook",
    profileName: null,
    text: "Hello from Facebook",
    mediaId: null,
    mediaUrl: null,
    mediaType: null,
    unsupportedType: null,
  });
});

test("parses Instagram image messages and skips message echoes", () => {
  const parsed = meta.parseIncomingMessages({
    object: "instagram",
    entry: [
      {
        id: "ig-business-1",
        messaging: [
          {
            sender: { id: "igsid-1" },
            recipient: { id: "ig-business-1" },
            message: {
              mid: "ig-mid-1",
              text: "This one",
              attachments: [
                { type: "image", payload: { url: "https://cdn.example.test/photo.jpg" } },
              ],
            },
          },
          {
            sender: { id: "ig-business-1" },
            recipient: { id: "igsid-1" },
            message: { mid: "ig-echo-1", text: "Our reply", is_echo: true },
          },
        ],
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].channel, "instagram");
  assert.equal(parsed[0].from, "igsid-1");
  assert.equal(parsed[0].mediaType, "image");
  assert.equal(parsed[0].mediaUrl, "https://cdn.example.test/photo.jpg");
  assert.equal(parsed[0].text, "This one");
});

test("Facebook sends through the Page messages endpoint without returning a WhatsApp WAMID", async (t) => {
  const originalFetch = global.fetch;
  const oldPageId = process.env.FACEBOOK_PAGE_ID;
  const oldToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldPageId === undefined) delete process.env.FACEBOOK_PAGE_ID;
    else process.env.FACEBOOK_PAGE_ID = oldPageId;
    if (oldToken === undefined) delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.FACEBOOK_PAGE_ACCESS_TOKEN = oldToken;
  });

  process.env.FACEBOOK_PAGE_ID = "page-123";
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "page-token";

  global.fetch = async (url, options) => {
    assert.equal(url, "https://graph.facebook.com/v26.0/page-123/messages");
    assert.equal(options.headers.Authorization, "Bearer page-token");
    assert.deepEqual(JSON.parse(options.body), {
      recipient: { id: "psid-9" },
      message: { text: "Hi" },
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ recipient_id: "psid-9", message_id: "fb-out-1" }),
    };
  };

  const result = await meta.sendText("facebook", "psid-9", "Hi");
  assert.equal(result.success, true);
  assert.equal(result.wamid, null);
  assert.equal(result.externalMessageId, "fb-out-1");
});

test("Instagram sends through the Instagram messages endpoint", async (t) => {
  const originalFetch = global.fetch;
  const oldAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
  const oldToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldAccountId === undefined) delete process.env.INSTAGRAM_ACCOUNT_ID;
    else process.env.INSTAGRAM_ACCOUNT_ID = oldAccountId;
    if (oldToken === undefined) delete process.env.INSTAGRAM_ACCESS_TOKEN;
    else process.env.INSTAGRAM_ACCESS_TOKEN = oldToken;
  });

  process.env.INSTAGRAM_ACCOUNT_ID = "ig-business-123";
  process.env.INSTAGRAM_ACCESS_TOKEN = "ig-token";

  global.fetch = async (url, options) => {
    assert.equal(url, "https://graph.instagram.com/v26.0/ig-business-123/messages");
    assert.equal(options.headers.Authorization, "Bearer ig-token");
    assert.deepEqual(JSON.parse(options.body), {
      recipient: { id: "igsid-9" },
      message: { text: "Hi IG" },
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ recipient_id: "igsid-9", message_id: "ig-out-1" }),
    };
  };

  const result = await meta.sendText("instagram", "igsid-9", "Hi IG");
  assert.equal(result.success, true);
  assert.equal(result.wamid, null);
  assert.equal(result.externalMessageId, "ig-out-1");
});
