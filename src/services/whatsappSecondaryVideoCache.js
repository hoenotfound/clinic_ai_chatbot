"use strict";

// The secondary sender may reuse *uploads*, never message deliveries.
// Every customer still goes through the sender-specific one-shot, policy,
// cancellation and billing checks before the verified transport sends a media ID.
const { createCache } = require("./whatsappVideoMediaCache");

const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
// This map holds only pending uploads, never provider tokens or media bytes.
// The underlying cache deletes settled entries in finally.
const secondaryInFlight = new Map();
const uncertain = (code) => ({
  success: false, unknown: true, ambiguous: true, retryable: false, code,
});

function secondaryVideoCacheEligible({ env = process.env, storage, mediaKey }) {
  const secondaryId = String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "");
  return env.WHATSAPP_SECONDARY_VIDEO_MEDIA_CACHE_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "neutro_secondary" &&
    /^\d+$/.test(secondaryId) &&
    secondaryId !== String(env.WHATSAPP_PHONE_NUMBER_ID || "") &&
    typeof storage?.isSharedFollowUpConfigKey === "function" &&
    storage.isSharedFollowUpConfigKey(mediaKey, env) === true;
}

async function dispatchSecondaryFollowUpVideo({
  transport, mediaKey, mimeType, filename, caption,
  env = process.env, storage,
  preSendCheck, liveVideoApproval,
  prefetchedBytes = null,
  cacheFactory = createCache,
}) {
  const allowed = async () => {
    try {
      return liveVideoApproval() === true && await preSendCheck() === true;
    } catch {
      return false;
    }
  };
  if (!await allowed()) return uncertain("sender_followup_policy_changed_before_video");

  let mediaId = null;
  let cached = null;
  let cache = null;
  if (secondaryVideoCacheEligible({ env, storage, mediaKey })) {
    // createCache partitions the DB entry by the *secondary Meta phone ID*.
    // The only uploader available here is the sender-reverified secondary
    // transport. It cannot borrow a primary WhatsApp Meta media ID/token.
    cache = cacheFactory({
      inFlight: secondaryInFlight,
      phoneNumberId: () => env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      mediaStorage: storage,
      whatsappApi: {
        uploadMedia: async (buffer, type, name) => {
          const result = await transport.uploadMedia(buffer, type, name);
          const id = String(result?.mediaId || "");
          return result?.success === true && /^\d+$/.test(id) ? id : null;
        },
      },
    });
    try {
      cached = await cache.resolveMediaId({
        videoKey: mediaKey, mimeType, filename,
        uploadOptions: { preSendCheck: allowed },
      });
    } catch {
      // Cache infrastructure is optional. Do not bypass any sender, audience
      // or billing guard when falling back to the old upload path.
      cached = { kind: "bypass" };
    }
    if (cached?.kind === "cancelled") {
      return uncertain("sender_followup_policy_changed_during_video");
    }
    if (cached?.kind === "download_failed" || cached?.kind === "upload_failed") {
      // An upload with an unknown result must NOT be attempted again here.
      return uncertain("sender_followup_cached_video_preparation_unconfirmed");
    }
    if (cached?.kind === "ready") mediaId = cached.mediaId;
  }

  if (!mediaId) {
    let bytes = prefetchedBytes;
    if (!bytes) {
      try {
        bytes = await storage.downloadMedia(mediaKey, { maxBytes: MAX_VIDEO_BYTES });
      } catch {
        return uncertain("sender_followup_media_unavailable");
      }
    }
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_VIDEO_BYTES) {
      return uncertain("sender_followup_media_unavailable");
    }
    if (!await allowed()) return uncertain("sender_followup_policy_changed_before_upload");
    const uploaded = await transport.uploadMedia(bytes, mimeType, filename);
    if (uploaded?.success !== true || !uploaded.mediaId) {
      return uncertain("sender_followup_video_upload_unconfirmed");
    }
    mediaId = uploaded.mediaId;
  }

  // A customer can opt out, book or be taken over while the shared upload
  // finishes. Recheck immediately before the ONE provider message attempt.
  if (!await allowed()) return uncertain("sender_followup_policy_changed_after_upload");
  const result = await transport.sendMediaById("video", mediaId, {
    caption, filename, voice: false,
  });
  if (cached?.kind === "ready") {
    // Invalidate only a definite media-specific Meta rejection, and NEVER
    // resend the same one-shot follow-up on an unknown provider outcome.
    try { await cache.invalidateIfRejected(cached, result); } catch (_) {}
  }
  return result;
}

module.exports = { MAX_VIDEO_BYTES, secondaryVideoCacheEligible, dispatchSecondaryFollowUpVideo };
