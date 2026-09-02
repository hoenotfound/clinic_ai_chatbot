const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const meta = require("../src/services/metaMessagingService");
const { verifyMetaWebhookSignature } = require("../src/middleware/verifyMetaWebhookSignature");

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

test("Instagram sends through the Facebook Page messages endpoint with its Page access token", async (t) => {
  const originalFetch = global.fetch;
  const oldPageId = process.env.INSTAGRAM_PAGE_ID;
  const oldToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldPageId === undefined) delete process.env.INSTAGRAM_PAGE_ID;
    else process.env.INSTAGRAM_PAGE_ID = oldPageId;
    if (oldToken === undefined) delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    else process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = oldToken;
  });

  process.env.INSTAGRAM_PAGE_ID = "ig-page-123";
  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = "ig-page-token";

  global.fetch = async (url, options) => {
    assert.equal(url, "https://graph.facebook.com/v26.0/ig-page-123/messages");
    assert.equal(options.headers.Authorization, "Bearer ig-page-token");
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

test("legacy Instagram Login credentials alone no longer configure Instagram Messaging", (t) => {
  const keys = [
    "INSTAGRAM_PAGE_ID",
    "INSTAGRAM_PAGE_ACCESS_TOKEN",
    "INSTAGRAM_ACCOUNT_ID",
    "INSTAGRAM_ACCESS_TOKEN",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key];
      else process.env[key] = old[key];
    }
  });

  delete process.env.INSTAGRAM_PAGE_ID;
  delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  process.env.INSTAGRAM_ACCOUNT_ID = "old-instagram-account-id";
  process.env.INSTAGRAM_ACCESS_TOKEN = "old-instagram-login-token";

  assert.equal(meta.configured("instagram"), false);
});

test("fetches a Facebook Messenger user's display name and profile photo", async (t) => {
  const originalFetch = global.fetch;
  const oldToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.FACEBOOK_PAGE_ACCESS_TOKEN = oldToken;
  });

  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "profile-page-token";

  global.fetch = async (url, options) => {
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.origin, "https://graph.facebook.com");
    assert.equal(parsedUrl.pathname, "/v26.0/psid-profile-1");
    assert.equal(parsedUrl.searchParams.get("fields"), "first_name,last_name,profile_pic");
    assert.equal(options.headers.Authorization, "Bearer profile-page-token");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        first_name: "Deon",
        last_name: "Tan",
        profile_pic: "https://example.test/facebook.jpg",
      }),
    };
  };

  const profile = await meta.fetchUserProfile("facebook", "psid-profile-1");
  assert.deepEqual(profile, {
    profileName: "Deon Tan",
    photoUrl: "https://example.test/facebook.jpg",
    username: null,
  });
});

test("fetches an Instagram user's profile through Facebook Graph with the Page token", async (t) => {
  const originalFetch = global.fetch;
  const oldToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  t.after(() => {
    global.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    else process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = oldToken;
  });

  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = "profile-ig-page-token";

  global.fetch = async (url, options) => {
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.origin, "https://graph.facebook.com");
    assert.equal(parsedUrl.pathname, "/v26.0/igsid-profile-1");
    assert.equal(parsedUrl.searchParams.get("fields"), "name,username,profile_pic");
    assert.equal(options.headers.Authorization, "Bearer profile-ig-page-token");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: "Alicia Lim",
        username: "alicialim",
        profile_pic: "https://example.test/instagram.jpg",
      }),
    };
  };

  const profile = await meta.fetchUserProfile("instagram", "igsid-profile-1");
  assert.deepEqual(profile, {
    profileName: "Alicia Lim",
    photoUrl: "https://example.test/instagram.jpg",
    username: "alicialim",
  });
});

test("shared Meta app secret verifies Instagram and Facebook webhook signatures", (t) => {
  const oldMetaSecret = process.env.META_APP_SECRET;
  const oldInstagramSecret = process.env.INSTAGRAM_APP_SECRET;
  t.after(() => {
    if (oldMetaSecret === undefined) delete process.env.META_APP_SECRET;
    else process.env.META_APP_SECRET = oldMetaSecret;
    if (oldInstagramSecret === undefined) delete process.env.INSTAGRAM_APP_SECRET;
    else process.env.INSTAGRAM_APP_SECRET = oldInstagramSecret;
  });

  process.env.META_APP_SECRET = "shared-meta-app-secret";
  process.env.INSTAGRAM_APP_SECRET = "unused-instagram-secret";
  const body = Buffer.from(JSON.stringify({ object: "instagram", entry: [] }));
  const signature =
    "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex");

  assert.doesNotThrow(() =>
    verifyMetaWebhookSignature(
      { headers: { "x-hub-signature-256": signature } },
      {},
      body
    )
  );

  const wrongSignature =
    "sha256=" + crypto.createHmac("sha256", process.env.INSTAGRAM_APP_SECRET).update(body).digest("hex");
  assert.throws(
    () =>
      verifyMetaWebhookSignature(
        { headers: { "x-hub-signature-256": wrongSignature } },
        {},
        body
      ),
    /signature mismatch/
  );
});
