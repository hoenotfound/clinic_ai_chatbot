const { spawn } = require("node:child_process");
const ffmpegPath = require("ffmpeg-static");
const mediaStorage = require("./mediaStorageService");
const { jpegFrameEncoding } = require("../utils/jpegEncoding");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 4;
const cache = new Map();
const pending = new Map();

function normalizeProgressiveJpeg(buffer, { timeoutMs = 8000, spawnFn = spawn } = {}) {
  if (!ffmpegPath) return Promise.reject(new Error("Image conversion is unavailable on this server."));
  return new Promise((resolve, reject) => {
    const child = spawnFn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "1", "-i", "pipe:0",
      "-vf", "scale=w=min(1920\\,iw):h=min(1920\\,ih):force_original_aspect_ratio=decrease",
      "-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
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
  const operation = (async () => {
    // Historical objects lack an encoding marker. Inspect only their header;
    // baseline files continue through R2 CopyObject without downloading pixels.
    const header = await storage.downloadMedia(key, { range: "bytes=0-1048575", maxBytes: 1024 * 1024, timeoutMs: 5000 });
    let value = null;
    if (jpegFrameEncoding(header) === "progressive") {
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

module.exports = { normalizeProgressiveJpeg, prepareStoredInboxImage };
