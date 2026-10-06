const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { normalizeProgressiveJpeg, prepareStoredInboxImage } = require("../src/services/inboxImagePreparationService");
const { jpegFrameEncoding } = require("../src/utils/jpegEncoding");
const PROGRESSIVE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAAgADADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAAABf/aAAwDAQACEAMQAAABjFCaAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAED/2gAIAQEAAQUCR//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8BX//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8BX//EABQQAQAAAAAAAAAAAAAAAAAAAED/2gAIAQEABj8CR//EABQQAQAAAAAAAAAAAAAAAAAAAED/2gAIAQEAAT8hR//aAAwDAQACAAMAAAAQ/wD/AP8A/wD/AP/EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8QX//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8QX//EABQQAQAAAAAAAAAAAAAAAAAAAED/2gAIAQEAAT8QR//Z", "base64");

test("the installed decoder produces a baseline JPEG for a real progressive JPEG", async () => {
  assert.equal(jpegFrameEncoding(PROGRESSIVE_JPEG), "progressive");
  const converted = await normalizeProgressiveJpeg(PROGRESSIVE_JPEG);
  assert.equal(jpegFrameEncoding(converted), "non-progressive");
  assert.ok(converted.length > 0 && converted.length < 5 * 1024 * 1024);
});

test("conversion kills a stalled decoder within its budget", async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  await assert.rejects(normalizeProgressiveJpeg(PROGRESSIVE_JPEG, { timeoutMs: 15, spawnFn: () => child }), /timed out/);
  assert.equal(killed, true);
});

test("known baseline objects keep the zero-byte-download forwarding path", async () => {
  const result = await prepareStoredInboxImage({ media_key: "clients/demo/messages/1/id-baseline.jpg", media_mime_type: "image/jpeg" },
    { storage: { downloadMedia: () => { throw new Error("unexpected download"); } } });
  assert.equal(result, null);
});

test("historical progressive JPEG preparation is shared across targets and cached", async () => {
  let downloads = 0, conversions = 0;
  const source = { media_key: "clients/demo/messages/1/progressive-test.jpg", media_mime_type: "image/jpeg" };
  const options = {
    storage: { async downloadMedia() { downloads += 1; return PROGRESSIVE_JPEG; } },
    normalize: async () => { conversions += 1; return Buffer.from("normalized"); },
  };
  const results = await Promise.all([prepareStoredInboxImage(source, options), prepareStoredInboxImage(source, options)]);
  assert.equal(downloads, 2); // bounded header + original, shared by both targets
  assert.equal(conversions, 1);
  assert.equal(results[0], results[1]);
  assert.equal(await prepareStoredInboxImage(source, options), results[0]);
  assert.equal(conversions, 1);
});
