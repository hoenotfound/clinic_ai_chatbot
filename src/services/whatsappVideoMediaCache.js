"use strict";
const crypto = require("node:crypto");
const repository = require("../db/whatsappVideoMediaCacheRepo");
const storage = require("./mediaStorageService");
const whatsapp = require("./whatsappService");

const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const WAIT_ATTEMPTS = 36;
const WAIT_MS = 1000; // 35s DB claim, plus one reclaim attempt if the uploader died.

function definitelyInvalidMediaId(result) {
  if (!result || result.success !== false || result.ambiguous === true ||
      result.unknown === true || result.policyBlocked === true ||
      result.retryable === true || result.wamid ||
      !(result.providerStatus >= 400 && result.providerStatus < 500)) return false;
  // Avoid matching unrelated Graph errors such as "invalid recipient ID".
  // Require a media-specific Meta error, not just any 400.
  const error = String(result.error || "").slice(0, 400);
  return /(?:media|video|file)(?:[ -]?id)?[\\s\\S]{0,70}(?:invalid|expired|not found|does not exist|unsupported)|(?:invalid|expired|not found|does not exist|unsupported)[\\s\\S]{0,70}(?:media|video|file)(?:[ -]?id)?/i.test(error);
}

function createCache({
  repo = repository,
  mediaStorage = storage,
  whatsappApi = whatsapp,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  phoneNumberId = () => process.env.WHATSAPP_PHONE_NUMBER_ID,
} = {}) {
  const inFlight = new Map();
  function measure(phoneId, event, bytes = 0) {
    if (!phoneId || typeof repo.recordEvent !== "function") return;
    Promise.resolve().then(() => repo.recordEvent(phoneId, event, bytes))
      .catch(() => console.warn("[WhatsApp video cache] Telemetry write unavailable"));
  }

  async function resolveMediaId({ videoKey, mimeType, filename, uploadOptions = {} }) {
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
        if (reusableId) {
          measure(phoneId, "hit", info.bytes);
          return { kind: "ready", mediaId: reusableId, fingerprint, phoneId, cacheHit: true };
        }
        measure(phoneId, "miss");
      } catch (error) {
        console.warn("[WhatsApp video cache] Read unavailable; using original upload");
        measure(phoneId, "fallback");
        return { kind: "bypass" };
      }

      const claimId = crypto.randomUUID();
      let claimed;
      try {
        claimed = await repo.claim(phoneId, fingerprint, mimeType, claimId);
      } catch (error) {
        console.warn("[WhatsApp video cache] Claim unavailable; using original upload");
        measure(phoneId, "fallback");
        return { kind: "bypass" };
      }
      if (!claimed) {
        for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
          // The sending worker may have been cancelled while waiting. Do not
          // start an upload once the customer has replied or the window closed.
          if (attempt % 4 === 0 && typeof uploadOptions.preSendCheck === "function") {
            try {
              if (await uploadOptions.preSendCheck() !== true) return { kind: "cancelled" };
            } catch (_) { return { kind: "cancelled" }; }
          }
          await sleep(WAIT_MS);
          try {
            const readyId = await repo.get(phoneId, fingerprint);
            if (readyId) {
              measure(phoneId, "hit", info.bytes);
              return { kind: "ready", mediaId: readyId, fingerprint, phoneId, cacheHit: true };
            }
            // After the 35-second lease, a dead worker can be recovered.
            // claim() is atomic; exactly one waiting worker can take over.
            if (attempt >= 34) {
              claimed = await repo.claim(phoneId, fingerprint, mimeType, claimId);
              if (claimed) break;
            }
          } catch (_) {
            measure(phoneId, "fallback");
            return { kind: "bypass" };
          }
        }
        if (!claimed) {
          // Last-resort availability fallback. A hung provider should never
          // block a customer's approved message indefinitely.
          measure(phoneId, "fallback");
          return { kind: "bypass" };
        }
      }
      if (typeof uploadOptions.preSendCheck === "function") {
        try {
          if (await uploadOptions.preSendCheck() !== true) {
            await repo.release(phoneId, fingerprint, claimId);
            return { kind: "cancelled" };
          }
        } catch (_) {
          await repo.release(phoneId, fingerprint, claimId);
          return { kind: "cancelled" };
        }
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
        uploadedId = await whatsappApi.uploadMedia(buffer, mimeType, filename, uploadOptions);
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
        const saved = await repo.save(phoneId, fingerprint, claimId, String(uploadedId));
        if (!saved) {
          try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
        }
      } catch (error) {
        // Meta has the video. A cache write failure must not fail its first send.
        console.warn("[WhatsApp video cache] Save unavailable; proceeding with uploaded media");
        try { await repo.release(phoneId, fingerprint, claimId); } catch (_) {}
      }
      measure(phoneId, "upload");
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
      const changed = await repo.invalidate(resolved.phoneId, resolved.fingerprint, resolved.mediaId);
      if (changed) measure(resolved.phoneId, "invalid");
      return changed === true;
    } catch (error) {
      console.warn("[WhatsApp video cache] Invalidation unavailable");
      return false;
    }
  }

  function recordRecovery(resolved) {
    if (resolved?.phoneId) measure(resolved.phoneId, "recovered");
  }
  return { resolveMediaId, invalidateIfRejected, recordRecovery };
}

module.exports = { ...createCache(), createCache, definitelyInvalidMediaId };
