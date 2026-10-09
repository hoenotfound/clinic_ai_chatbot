"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const clinicConfig = require("../config/clinicConfig");
const mediaStorage = require("./mediaStorageService");
const promoImagesRepo = require("../db/promoImagesRepo");
const { jpegFrameInfo } = require("../utils/jpegEncoding");
const { normalizeProgressiveJpeg } = require("./inboxImagePreparationService");
const { probeVideoInfo, isWhatsAppSafeVideoInfo } = require("./followUpVideoPreparationService");

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IEND_TRAILER = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

function mediaError(message, code = "invalid_template_media") {
  const e = new Error(message);
  e.code = code;
  return e;
}

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 && width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

/** Validate bounded JPEG/PNG structures. Reuse the already bounded JPEG
 * normalizer for progressive JPEG; never transcode video on Render. */
async function prepareImage(buffer, mimeType, { normalize = normalizeProgressiveJpeg } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_IMAGE_BYTES) {
    throw mediaError("WhatsApp template images must be nonempty and no larger than 5MB.");
  }
  if (mimeType === "image/jpeg") {
    const frame = jpegFrameInfo(buffer);
    if (!frame || frame.precision !== 8 || ![1, 3].includes(frame.components) ||
        !validDimensions(frame.width, frame.height) ||
        buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
      throw mediaError("Invalid or oversized JPEG image. Please export a standard JPEG under 5MB.");
    }
    if (frame.encoding === "progressive") {
      const normalized = await normalize(buffer);
      return prepareImage(normalized, mimeType, { normalize: async () => {
        throw mediaError("The JPEG could not be normalized safely.");
      } });
    }
    return buffer;
  }
  if (mimeType === "image/png") {
    if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
        buffer.readUInt32BE(8) !== 13 ||
        buffer.toString("ascii", 12, 16) !== "IHDR" ||
        !validDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20)) ||
        ![1, 2, 4, 8, 16].includes(buffer[24]) ||
        ![0, 2, 3, 4, 6].includes(buffer[25]) ||
        !buffer.subarray(-12).equals(IEND_TRAILER)) {
      throw mediaError("Invalid or oversized PNG image. Please export a standard PNG under 5MB.");
    }
    return buffer;
  }
  throw mediaError("WhatsApp media templates accept JPEG or PNG images only.");
}

async function verifyVideoBuffer(buffer, { probe = probeVideoInfo } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_VIDEO_BYTES) {
    throw mediaError("WhatsApp template videos must be no larger than 16MB.");
  }
  const filepath = path.join(os.tmpdir(), "template-video-check-" + randomUUID() + ".mp4");
  try {
    await fs.writeFile(filepath, buffer, { flag: "wx" });
    const info = await probe(filepath);
    if (!isWhatsAppSafeVideoInfo(info)) {
      throw mediaError("This video uses an unsupported codec. Export H.264 MP4 with AAC audio.");
    }
    return buffer;
  } finally {
    await fs.unlink(filepath).catch(() => {});
  }
}

function promoIdFromUrl(url) {
  // An exact local promo-image path. Never select result-media/private
  // patient assets or arbitrary URLs from the browser.
  const match = String(url || "").match(/\/promo-images\/([1-9]\d*)(?:\?.*)?$/);
  return match ? Number(match[1]) : null;
}

function currentlyValid(promo, now) {
  const start = String(promo?.validFrom || "");
  const end = String(promo?.validUntil || "");
  const today = new Date(now).toISOString().slice(0, 10);
  return (!start || today >= start.slice(0, 10)) &&
    (!end || today <= end.slice(0, 10));
}

function listReusableMedia({ config = clinicConfig, now = Date.now() } = {}) {
  const result = [];
  const seen = new Set();
  function addVideo(key, label, filename) {
    if (!key || !mediaStorage.isSharedFollowUpConfigKey(key) || !/\.mp4$/i.test(key)) return;
    const id = "video:" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
    if (seen.has(id)) return;
    seen.add(id);
    result.push({ id, label, format: "VIDEO", filename: filename || "follow-up.mp4", mediaKey: key });
  }
  const followUp = config?.automatedFollowUp || {};
  const steps = [followUp, ...(followUp.additionalSteps || [])];
  for (const [index, step] of steps.entries()) {
    addVideo(step?.videoKey, "Follow-up " + (index + 1) + " — General", step?.videoFilename);
    for (const override of step?.serviceOverrides || []) {
      addVideo(override?.videoKey, "Follow-up " + (index + 1) + " — " + (override.serviceName || "Treatment"), override?.videoFilename);
    }
  }
  for (const promo of config?.promotions || []) {
    if (!currentlyValid(promo, now)) continue;
    function addImage(url, label) {
      const idValue = promoIdFromUrl(url);
      if (!idValue) return;
      const id = "promo:" + idValue;
      if (seen.has(id)) return;
      seen.add(id);
      result.push({ id, label, format: "IMAGE", imageId: idValue, filename: "promotion-" + idValue + ".jpg" });
    }
    addImage(promo.imageUrl, promo.name || "Promotion");
    for (const pkg of promo.packages || []) {
      addImage(pkg.followUpImageUrl || pkg.imageUrl, (promo.name || "Promotion") + " — " + (pkg.name || pkg.title || "Package"));
    }
  }
  return result;
}

function publicMediaOptions(options = listReusableMedia()) {
  return options.map(({ id, label, format }) => ({ id, label, format }));
}

async function resolveReusableMedia(selectionId, expectedFormat, {
  config = clinicConfig, now = Date.now(),
  store = mediaStorage, promos = promoImagesRepo,
  validateImage = prepareImage, validateVideo = verifyVideoBuffer,
} = {}) {
  const option = listReusableMedia({ config, now }).find((item) => item.id === selectionId);
  if (!option || option.format !== expectedFormat) {
    throw mediaError("That clinic media item is no longer available for this template.", "reusable_media_unavailable");
  }
  if (option.format === "VIDEO") {
    const info = await store.getSharedFollowUpMediaInfo(option.mediaKey);
    if (!info || info.mimeType !== "video/mp4" || info.bytes <= 0 || info.bytes > MAX_VIDEO_BYTES) {
      throw mediaError("The shared video is missing or exceeds the WhatsApp video limit.");
    }
    const buffer = await store.downloadMedia(option.mediaKey, { maxBytes: MAX_VIDEO_BYTES });
    await validateVideo(buffer);
    return { buffer, mimeType: "video/mp4", mediaKey: option.mediaKey,
      mediaUrl: null, filename: option.filename, mediaSelectionId: option.id };
  }
  const record = await promos.getPublicImage(option.imageId);
  if (!record || !["image/jpeg", "image/png"].includes(record.mime_type)) {
    throw mediaError("The promotion graphic is unavailable or private.", "reusable_media_unavailable");
  }
  const buffer = await validateImage(Buffer.from(record.data, "base64"), record.mime_type);
  return { buffer, mimeType: record.mime_type,
    mediaKey: null, mediaUrl: "/promo-images/" + option.imageId,
    filename: option.filename, mediaSelectionId: option.id };
}

module.exports = {
  MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, prepareImage, verifyVideoBuffer,
  promoIdFromUrl, currentlyValid, listReusableMedia, publicMediaOptions,
  resolveReusableMedia,
};