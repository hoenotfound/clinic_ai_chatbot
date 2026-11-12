const test = require("node:test");
const assert = require("node:assert/strict");
const metaAttachments = require("../src/services/metaAttachmentService");

function mockFacebook(t, sendResponse) {
  const oldToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const oldPage = process.env.FACEBOOK_PAGE_ID;
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "unit-test-token";
  process.env.FACEBOOK_PAGE_ID = "unit-test-page";
  t.after(() => {
    if (oldToken === undefined) delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    else process.env.FACEBOOK_PAGE_ACCESS_TOKEN = oldToken;
    if (oldPage === undefined) delete process.env.FACEBOOK_PAGE_ID;
    else process.env.FACEBOOK_PAGE_ID = oldPage;
  });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (String(url).endsWith("/message_attachments")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ attachment_id: "test-attachment" }) };
    }
    if (String(url).endsWith("/messages")) {
      if (sendResponse instanceof Error) throw sendResponse;
      return {
        ok: sendResponse.status >= 200 && sendResponse.status < 300,
        status: sendResponse.status,
        text: async () => JSON.stringify(sendResponse.body),
      };
    }
    throw new Error("Unexpected Meta endpoint");
  });
  return calls;
}

const video = {
  channel: "facebook", recipient: "psid-test", type: "video",
  buffer: Buffer.from("video"), mime: "video/mp4", filename: "test.mp4",
};

async function sendVideo() {
  return metaAttachments.sendBuffer(
    video.channel, video.recipient, video.type, video.buffer, video.mime, video.filename
  );
}

test("a video message HTTP 500 is unconfirmed, not a known failure", async t => {
  const calls = mockFacebook(t, { status: 500, body: { error: { message: "An unknown error occurred" } } });
  const result = await sendVideo();
  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.equal(result.ambiguous, true);
  assert.match(result.error, /video delivery is unconfirmed/i);
  assert.equal(calls.length, 2);
});

test("a video message HTTP 200 without an ID is unconfirmed", async t => {
  const calls = mockFacebook(t, { status: 200, body: { recipient_id: "psid-test" } });
  const result = await sendVideo();
  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.match(result.error, /no valid message ID/);
  assert.equal(calls.length, 2);
});

test("a video message transport failure is unconfirmed", async t => {
  const calls = mockFacebook(t, new Error("connection reset after POST"));
  const result = await sendVideo();
  assert.equal(result.success, false);
  assert.equal(result.unknown, true);
  assert.equal(result.ambiguous, true);
  assert.equal(calls.length, 2);
});

test("definite video send HTTP 400 remains failed and retryable by policy", async t => {
  const calls = mockFacebook(t, { status: 400, body: { error: { message: "Unsupported video" } } });
  const result = await sendVideo();
  assert.equal(result.success, false);
  assert.notEqual(result.unknown, true);
  assert.equal(calls.length, 2);
});

test("a video message with valid provider ID remains accepted", async t => {
  const calls = mockFacebook(t, { status: 200, body: { message_id: "mid-video-123" } });
  const result = await sendVideo();
  assert.equal(result.success, true);
  assert.equal(result.externalMessageId, "mid-video-123");
  assert.equal(calls.length, 2);
});

test("a video URL send shares the same uncertain-delivery rules", async t => {
  const calls = mockFacebook(t, { status: 503, body: { error: { message: "Service unavailable" } } });
  const result = await metaAttachments.sendUrlAttachment(
    "facebook", "psid-test", "video", "https://r2.example.test/signed.mp4"
  );
  assert.equal(result.unknown, true);
  assert.equal(calls.length, 1);
});
