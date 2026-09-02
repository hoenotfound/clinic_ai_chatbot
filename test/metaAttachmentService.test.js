const test = require("node:test");
const assert = require("node:assert/strict");

const metaAttachments = require("../src/services/metaAttachmentService");

test("Facebook attachment send uploads bytes then sends attachment id", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const originalPageId = process.env.FACEBOOK_PAGE_ID;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.FACEBOOK_PAGE_ACCESS_TOKEN = originalToken;
    if (originalPageId === undefined) delete process.env.FACEBOOK_PAGE_ID;
    else process.env.FACEBOOK_PAGE_ID = originalPageId;
  });

  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "test-token";
  process.env.FACEBOOK_PAGE_ID = "page-123";

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/message_attachments")) {
      return new Response(JSON.stringify({ attachment_id: "att-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message_id: "mid-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await metaAttachments.sendBuffer(
    "facebook",
    "psid-1",
    "image",
    Buffer.from("image-bytes"),
    "image/jpeg",
    "photo.jpg"
  );

  assert.equal(result.success, true);
  assert.equal(result.externalMessageId, "mid-1");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/graph\.facebook\.com\/v26\.0\/page-123\/message_attachments$/);
  assert.equal(calls[0].options.method, "POST");
  assert.ok(calls[0].options.body instanceof FormData);

  assert.match(calls[1].url, /^https:\/\/graph\.facebook\.com\/v26\.0\/page-123\/messages$/);
  const sentBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(sentBody.recipient, { id: "psid-1" });
  assert.equal(sentBody.message.attachment.type, "image");
  assert.equal(sentBody.message.attachment.payload.attachment_id, "att-1");
});

test("Instagram audio uses graph.instagram.com for upload and delivery", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
  const originalPageId = process.env.INSTAGRAM_PAGE_ID;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.INSTAGRAM_PAGE_ACCESS_TOKEN;
    else process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = originalToken;
    if (originalPageId === undefined) delete process.env.INSTAGRAM_PAGE_ID;
    else process.env.INSTAGRAM_PAGE_ID = originalPageId;
  });

  process.env.INSTAGRAM_PAGE_ACCESS_TOKEN = "ig-token";
  process.env.INSTAGRAM_PAGE_ID = "ig-page-1";

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/message_attachments")) {
      return new Response(JSON.stringify({ attachment_id: "ig-att-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ message_id: "ig-mid-1" }), { status: 200 });
  };

  const result = await metaAttachments.sendBuffer(
    "instagram",
    "igsid-1",
    "audio",
    Buffer.from("mp3-bytes"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(result.success, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/graph\.instagram\.com\/v26\.0\/ig-page-1\/message_attachments$/);
  assert.match(calls[1].url, /^https:\/\/graph\.instagram\.com\/v26\.0\/ig-page-1\/messages$/);
  const sentBody = JSON.parse(calls[1].options.body);
  assert.equal(sentBody.recipient.id, "igsid-1");
  assert.equal(sentBody.message.attachment.type, "audio");
  assert.equal(sentBody.message.attachment.payload.attachment_id, "ig-att-1");
});

test("attachment upload failure is returned without attempting delivery", async (t) => {
  const originalFetch = global.fetch;
  const originalToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const originalPageId = process.env.FACEBOOK_PAGE_ID;
  t.after(() => {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.FACEBOOK_PAGE_ACCESS_TOKEN = originalToken;
    if (originalPageId === undefined) delete process.env.FACEBOOK_PAGE_ID;
    else process.env.FACEBOOK_PAGE_ID = originalPageId;
  });

  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "test-token";
  process.env.FACEBOOK_PAGE_ID = "page-123";

  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { message: "Unsupported attachment" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  };

  const result = await metaAttachments.sendBuffer(
    "facebook",
    "psid-1",
    "audio",
    Buffer.from("audio"),
    "audio/mpeg",
    "voice.mp3"
  );

  assert.equal(result.success, false);
  assert.equal(result.error, "Unsupported attachment");
  assert.equal(calls, 1);
});
