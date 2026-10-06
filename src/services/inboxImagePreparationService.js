const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const mediaStorage = require("./mediaStorageService");
const { jpegFrameEncoding, jpegFrameInfo } = require("../utils/jpegEncoding");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 4;
const MAX_JPEG_PIXELS = 16_000_000;
const MAX_JPEG_DIMENSION = 8192;
const MAX_PENDING_PREPARATIONS = 5;
const cache = new Map();
const pending = new Map();

function preparationBusyError() {
  return new Error("Image preparation is busy. Please try forwarding again shortly.");
}

// One decoder per instance protects memory and CPU needed by AI/webhooks. The
// waiting list also has a size and time limit, so it cannot retain files forever.
function createJpegConversionQueue({ maxWaiting = 4, waitTimeoutMs = 3000 } = {}) {
  let active = false;
  const waiting = [];
  function lease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(lease());
      } else active = false;
    };
  }
  return {
    acquire() {
      if (!active) {
        active = true;
        return Promise.resolve(lease());
      }
      if (waiting.length >= maxWaiting) return Promise.reject(preparationBusyError());
      return new Promise((resolve, reject) => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(preparationBusyError());
        }, waitTimeoutMs);
        waiting.push(entry);
      });
    },
  };
}

const conversionQueue = createJpegConversionQueue();

function validateJpegForConversion(buffer) {
  const frame = jpegFrameInfo(buffer);
  if (!frame || frame.precision !== 8 || ![1, 3].includes(frame.components) ||
      !frame.width || !frame.height || frame.width > MAX_JPEG_DIMENSION ||
      frame.height > MAX_JPEG_DIMENSION || frame.width * frame.height > MAX_JPEG_PIXELS) {
    throw new Error("This stored JPEG is too large or unsupported for safe conversion. Please upload a smaller JPEG or PNG copy.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Stored JPEG exceeds WhatsApp's 5MB image limit.");
  }
}

async function normalizeProgressiveJpeg(buffer, { timeoutMs = 8000, spawnFn = spawn, queue = conversionQueue } = {}) {
  validateJpegForConversion(buffer);
  if (!ffmpegPath) throw new Error("Image conversion is unavailable on this server.");
  const release = await queue.acquire();
  let child;
  try {
    child = spawnFn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "1",
      "-filter_threads", "1", "-max_pixels", String(MAX_JPEG_PIXELS), "-i", "pipe:0",
      "-vf", "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease",
      "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    release();
    throw error;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    let timer;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve(result);
    };
    timer = setTimeout(() => finish(new Error("Stored JPEG preparation timed out before sending.")), timeoutMs);
    child.on("error", finish);
    child.stderr.resume();
    child.stdin.on("error", () => {}); // A killed/failed decoder can close stdin early.
    child.stdout.on("error", finish);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_IMAGE_BYTES) return finish(new Error("Prepared JPEG exceeds WhatsApp's 5MB image limit."));
      chunks.push(chunk);
    });
    child.on("close", (code) => {
      // A timeout rejects promptly, but its slot stays occupied until SIGKILL
      // actually closes the decoder. Do not overlap it with the next process.
      release();
      if (finished) return;
      const result = Buffer.concat(chunks);
      if (code !== 0 || jpegFrameEncoding(result) !== "non-progressive") {
        finish(new Error("The stored JPEG could not be prepared safely. Please upload a JPEG or PNG copy."));
      } else finish(null, result);
    });
    child.stdin.end(buffer);
  });
}

async function prepareStoredInboxImage(sourceMessage, { storage = mediaStorage, normalize = normalizeProgressiveJpeg } = {}) {
  if (String(sourceMessage.media_mime_type).toLowerCase() !== "image/jpeg" || /-baseline\.jpg$/.test(sourceMessage.media_key)) return null;
  const key = sourceMessage.media_key;
  const now = Date.now();
  for (const [cachedKey, item] of cache) if (item.expiresAt <= now) { clearTimeout(item.timer); cache.delete(cachedKey); }
  if (cache.has(key)) return cache.get(key).value;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= MAX_PENDING_PREPARATIONS) throw preparationBusyError();
  const operation = (async () => {
    // Historical objects lack an encoding marker. Inspect only their header;
    // baseline files continue through R2 CopyObject without downloading pixels.
    const header = await storage.downloadMedia(key, { range: "bytes=0-1048575", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    let value = null;
    if (jpegFrameEncoding(header) === "progressive") {
      validateJpegForConversion(header);
      const original = await storage.downloadMedia(key, { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 10000 });
      value = { buffer: await normalize(original), mimeType: "image/jpeg" };
    }
    // Small, bounded process cache avoids repeating conversion across targets.
    // Every forwarded message still gets a permanent per-contact R2 object.
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      clearTimeout(cache.get(oldest).timer);
      cache.delete(oldest);
    }
    const expiresAt = Date.now() + CACHE_TTL_MS;
    const timer = setTimeout(() => {
      if (cache.get(key)?.expiresAt === expiresAt) cache.delete(key);
    }, CACHE_TTL_MS);
    timer.unref?.();
    cache.set(key, { value, expiresAt, timer });
    return value;
  })();
  pending.set(key, operation);
  try { return await operation; }
  finally { pending.delete(key); }
}

module.exports = { normalizeProgressiveJpeg, prepareStoredInboxImage, createJpegConversionQueue };
