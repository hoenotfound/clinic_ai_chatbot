"use strict";
const crypto = require("node:crypto");
const repository = require("../db/whatsappVideoMediaCacheRepo");
const storage = require("./mediaStorageService");
const whatsapp = require("./whatsappService");

const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const WAIT_ATTEMPTS = 12;
const WAIT_MS = 500;

function definitelyInvalidMediaId(result) {
  if (!result || result.success !== false || result.ambiguous === true ||
      result.policyBlocked === true || !(result.providerStatus >= 400 && result.providerStatus < 500)) {
    return false;
  }
  const error = String(result.error || "").slice(0, 400);
  return /(?:media|video|file|id).{0,70}(?:invalid|expired|not found|does not exist)|(?:invalid|expired|not found|does not exist).{0,70}(?:media|video|file|id)/i.test(error);
}

function createCache({
  repo = repository,
  mediaStorage = storage,
  whatsappApi = whatsapp,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID,
} = {}) {
  const inFlight = new Map();

  async function resolveMediaId({ videoKey, mimeType, filename }) {
    const phoneId = String(phoneNumberId() || "").trim();
    if (!/^\d+$/.test(phoneId) || !mediaStorage.isSharedFollowUpConfigKey(videoKey)) {
      return { kind: "bypass" };
    }

    let info;
    try {
      info = await mediaStorage.getSharedFollowUpMediaInfo(videoKey);
    } catch (error) {
      console.warn("[WhatsApp video cache] Metadata unavailable; using original upload");
      return { kind: "bypass" };
    }
    if (!info?.etag || !Number.isFinite(info.bytes) ||
        info.bytes <= 0 || info.bytes > MAX_VIDEO_BYTES ||
        info.mimeType !== mimeType) return { kind: "bypass" };

    // An overwritten object (even at the same key) gets a different fingerprint.
    // Never put the R2 object key or any patient information into the cache table.
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify([videoKey, info.etag, info.bytes, mimeType]))
      .digest("hex");
    const flightKey = phoneId + ":" + fingerprint;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);

    async function loadOrUpload() {
      try {
        const reusableId = await repo.get(phoneId, fingerprint);
        if (reusableId) return { kind: "ready", mediaId: reusableId, fingerprint, phoneId, cacheHit: true };
      } catch (error) {
        console.warn("[WhatsApp video cache] Read unavailable; using original upload");
        return { kind: "bypass" };
      }

      const claimId = crypto.randomUUID();
      let claimed;
      try {
        claimed = await repo.claim(phoneId, fingerprint, mimeType, claimId);
      } catch (error) {
        console.warn("[WhatsApp video cache] Claim unavailable; using original upload");
        return { kind: "bypass" };
      }
      if (!claimed) {
        for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
          await sleep(WAIT_MS);
          try {
            const readyId = await repo.get(phoneId, fingerprint);
            if (readyId) return { kind: "ready", mediaId: readyId, fingerprint, phoneId, cacheHit: true };
          } catch (error) {
            return { kind: "bypass" };
          }
        }
        // Never hold up a follow-up indefinitely because another uploader stalled.
        return { kind: "bypass" };
      }

      let buffer;
      try {
        buffer = await mediaStorage.downloadMedia(videoKey, { maxBytes: MAX_VIDEO_BYTES });
      } catch (error) {
        try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
        return { kind: "download_failed", error };
      }
      if (!buffer?.length) {
        try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
        return { kind: "upload_failed" };
      }

      let uploadedId;
      try {
        uploadedId = await whatsappApi.uploadMedia(buffer, mimeType, filename);
      } catch (error) {
        try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
        return { kind: "upload_failed" };
      } finally {
        buffer = null;
      }
      if (!uploadedId) {
        try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
        return { kind: "upload_failed" };
      }
      try {
        await repo.save(phoneId, fingerprint, claimId, String(uploadedId));
      } catch (error) {
        // Meta has the video. A cache write failure must not fail its first send.
        console.warn("[WhatsApp video cache] Save unavailable; proceeding with uploaded media");
      }
      return { kind: "ready", mediaId: String(uploadedId), fingerprint, phoneId, cacheHit: false };
    }

    const promise = loadOrUpload();
    inFlight.set(flightKey, promise);
    try {
      return await promise;
    } finally {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey);
    }
  }

  async function invalidateIfRejected(resolved, result) {
    if (resolved?.kind !== "ready" || !definitelyInvalidMediaId(result)) return false;
    try {
      await repo.invalidate(resolved.phoneId, resolved.fingerprint, resolved.mediaId);
      return true;
    } catch (error) {
      console.warn("[WhatsApp video cache] Invalidation unavailable");
      return false;
    }
  }

  return { resolveMediaId, invalidateIfRejected };
}

module.exports = { ...createCache(), createCache, definitelyInvalidMediaId };
