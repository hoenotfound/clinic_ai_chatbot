const test = require("node:test");
const assert = require("node:assert/strict");

const meta = require("../src/services/metaMessagingService");
const attachments = require("../src/services/metaAttachmentService");
const storage = require("../src/services/mediaStorageService");
const policy = require("../src/services/whatsappPolicyService");
const messaging = require("../src/services/channelMessagingService");

function setup(t, uploadResult, { onTemporary = () => {} } = {}) {
  const calls = [];
  const contact = { id: 9020, channel: "facebook", channel_user_id: "psid-9020" };
  t.mock.method(policy, "checkFreeformAllowed", async () => ({ allowed: true }));
  t.mock.method(storage, "downloadMedia", async () => Buffer.from("valid-video-bytes"));
  t.mock.method(storage, "uploadTemporaryMedia", async () => {
    throw new Error("Messenger fallback must not re-upload video bytes to R2");
  });
  t.mock.method(storage, "copyStoredMediaToTemporary", async (key, mimeType, options) => {
    onTemporary();
    calls.push(["temporary", key, mimeType, options.contactId]);
    return { url: "https://r2.example.test/temporary-video", key: "temporary-video-key" };
  });
  t.mock.method(storage, "scheduleTemporaryMediaDelete", key => {
    calls.push(["cleanup", key]);
  });
  t.mock.method(meta, "sendText", async (_channel, _recipient, caption) => {
    calls.push(["caption", caption]);
    return { success: true, externalMessageId: "caption-id" };
  });
  t.mock.method(attachments, "sendBuffer", async (_channel, _recipient, type) => {
    calls.push(["upload", type]);
    return uploadResult;
  });
  t.mock.method(attachments, "sendUrlAttachment", async (channel, recipient, type, url) => {
    calls.push(["url", channel, recipient, type, url]);
    return { success: true, externalMessageId: "sent-video-id" };
  });
  return { calls, contact };
}

test("Messenger video uses one private URL fallback after a definite upload 500, without repeating the caption", async t => {
  const { calls, contact } = setup(t, {
    success: false, uploadRejected: true, uploadHttpStatus: 500,
    error: "An unknown error occurred",
  });
  const result = await messaging.sendVideoByStoredKey(
    contact, "clinic/follow-up/9d.mp4", "Only once", "9d.mp4",
    { purpose: "marketing", preSendCheck: async () => true }
  );
  assert.equal(result.success, true);
  assert.equal(result.externalMessageId, "sent-video-id");
  assert.deepEqual(calls, [
    ["caption", "Only once"],
    ["upload", "video"],
    ["temporary", "clinic/follow-up/9d.mp4", "video/mp4", 9020],
    ["url", "facebook", "psid-9020", "video", "https://r2.example.test/temporary-video"],
    ["cleanup", "temporary-video-key"],
  ]);
});

test("Messenger video does not use the URL fallback after HTTP 400 media rejection", async t => {
  const { calls, contact } = setup(t, {
    success: false, uploadRejected: true, uploadHttpStatus: 400,
    error: "Invalid video",
  });
  const result = await messaging.sendVideoByStoredKey(
    contact, "clinic/follow-up/9d.mp4", undefined, "9d.mp4",
    { purpose: "marketing", preSendCheck: async () => true }
  );
  assert.equal(result.success, false);
  assert.deepEqual(calls, [["upload", "video"]]);
});

test("Messenger video never retries after a customer-facing Send API failure", async t => {
  const { calls, contact } = setup(t, {
    success: false, uploadHttpStatus: 500, // no uploadRejected: /messages was contacted
    error: "An unknown error occurred",
  });
  const result = await messaging.sendVideoByStoredKey(
    contact, "clinic/follow-up/9d.mp4", undefined, "9d.mp4",
    { purpose: "marketing", preSendCheck: async () => true }
  );
  assert.equal(result.success, false);
  assert.deepEqual(calls, [["upload", "video"]]);
});

test("Messenger video fallback cancels before sending if eligibility changes after upload", async t => {
  let eligible = true;
  // Ownership changes while preparing the provider-facing copy.
  const { calls, contact } = setup(t, {
    success: false, uploadRejected: true, uploadHttpStatus: 503,
    error: "Unavailable",
  }, { onTemporary: () => { eligible = false; } });
  const result = await messaging.sendVideoByStoredKey(
    contact, "clinic/follow-up/9d.mp4", undefined, "9d.mp4",
    { purpose: "marketing", preSendCheck: async () => eligible }
  );
  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.equal(calls.some(call => call[0] === "url"), false);
});
