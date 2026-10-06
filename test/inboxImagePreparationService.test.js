const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { normalizeProgressiveJpeg, prepareStoredInboxImage, createJpegConversionQueue } = require("../src/services/inboxImagePreparationService");
const { jpegFrameEncoding, jpegFrameInfo } = require("../src/utils/jpegEncoding");
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
  child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", null)); };
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

function jpegWithDimensions(width, height) {
  const bytes = Buffer.from(PROGRESSIVE_JPEG);
  const offset = bytes.indexOf(Buffer.from([0xff, 0xc2]));
  bytes.writeUInt16BE(height, offset + 5);
  bytes.writeUInt16BE(width, offset + 7);
  return bytes;
}

function fakeDecoder() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}

function completeDecoder(child) {
  const baseline = Buffer.from(PROGRESSIVE_JPEG);
  baseline[baseline.indexOf(Buffer.from([0xff, 0xc2])) + 1] = 0xc0;
  child.stdout.end(baseline);
  child.emit("close", 0);
}

test("a small compressed 48MP JPEG is rejected before decoder allocation or full download", async () => {
  const oversized = jpegWithDimensions(8000, 6000);
  assert.ok(oversized.length < 5 * 1024 * 1024);
  assert.equal(jpegFrameInfo(oversized).width, 8000);
  let spawned = false;
  await assert.rejects(normalizeProgressiveJpeg(oversized, { spawnFn: () => { spawned = true; } }), /smaller JPEG or PNG/);
  assert.equal(spawned, false);
  let downloads = 0;
  await assert.rejects(prepareStoredInboxImage({ media_key: "review/oversized.jpg", media_mime_type: "image/jpeg" }, {
    storage: { downloadMedia: async () => { downloads++; return oversized; } },
    normalize: () => { throw new Error("must not decode"); },
  }), /smaller JPEG or PNG/);
  assert.equal(downloads, 1);
});

test("missing or excessive JPEG dimensions fail before spawning", async () => {
  for (const buffer of [Buffer.from("invalid JPEG"), jpegWithDimensions(0, 32), jpegWithDimensions(8193, 1)]) {
    await assert.rejects(normalizeProgressiveJpeg(buffer, { spawnFn: () => { throw new Error("unexpected spawn"); } }), /safe conversion/);
  }
});

test("distinct JPEG conversions run one decoder at a time with decoder pixel and thread limits", async () => {
  const queue = createJpegConversionQueue();
  const children = [];
  const options = { queue, spawnFn: (_path, args) => {
    assert.equal(args[args.indexOf("-max_pixels") + 1], "16000000");
    assert.equal(args[args.indexOf("-filter_threads") + 1], "1");
    const child = fakeDecoder(); children.push(child); return child;
  } };
  const first = normalizeProgressiveJpeg(PROGRESSIVE_JPEG, options);
  const second = normalizeProgressiveJpeg(PROGRESSIVE_JPEG, options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 1);
  completeDecoder(children[0]);
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  completeDecoder(children[1]);
  await second;
});

test("conversion queue rejects overflow and expired waiters and remains usable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = createJpegConversionQueue({ maxWaiting: 1, waitTimeoutMs: 30 });
  const release = await queue.acquire();
  const waiting = assert.rejects(queue.acquire(), /preparation is busy/);
  await assert.rejects(queue.acquire(), /preparation is busy/);
  t.mock.timers.tick(30);
  await waiting;
  release();
  const nextRelease = await queue.acquire();
  nextRelease();
});

test("a timed-out decoder retains its slot until the killed process closes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = createJpegConversionQueue({ waitTimeoutMs: 100 });
  const children = [];
  const options = { queue, timeoutMs: 15, spawnFn: () => {
    const child = fakeDecoder(); children.push(child); return child;
  } };
  const first = assert.rejects(normalizeProgressiveJpeg(PROGRESSIVE_JPEG, options), /timed out/);
  const second = normalizeProgressiveJpeg(PROGRESSIVE_JPEG, options);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(15);
  await first;
  assert.equal(children[0].killed, true);
  assert.equal(children.length, 1);
  children[0].emit("close", null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(children.length, 2);
  completeDecoder(children[1]);
  await second;
});

test("a synchronous decoder spawn failure releases its queue slot", async () => {
  const queue = createJpegConversionQueue();
  await assert.rejects(normalizeProgressiveJpeg(PROGRESSIVE_JPEG, { queue, spawnFn: () => { throw new Error("spawn failed"); } }), /spawn failed/);
  const release = await queue.acquire();
  release();
});

test("historical preparation bounds outstanding downloads while sharing repeated targets", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let downloads = 0;
  const options = { storage: { downloadMedia: async () => { downloads++; return PROGRESSIVE_JPEG; } }, normalize: async () => { await gate; return Buffer.from("normalized"); } };
  const sources = Array.from({ length: 5 }, (_, i) => ({ media_key: `review/limit-${i}.jpg`, media_mime_type: "image/jpeg" }));
  const work = sources.map(source => prepareStoredInboxImage(source, options));
  const duplicate = prepareStoredInboxImage(sources[0], options);
  await assert.rejects(prepareStoredInboxImage({ media_key: "review/limit-overflow.jpg", media_mime_type: "image/jpeg" }, options), /preparation is busy/);
  release();
  const results = await Promise.all(work);
  assert.equal(await duplicate, results[0]);
  assert.equal(downloads, 10);
});
