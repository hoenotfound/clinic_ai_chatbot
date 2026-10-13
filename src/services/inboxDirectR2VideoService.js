"use strict";

// No global rollout: each deployment explicitly opts in. Public URLs and
// credentials are never sent to the browser, only one short-lived signed GET.
const VIDEO_URL_TTL_SECONDS = 10 * 60;

function shouldTryDirectInboxVideo(mediaRef, query = {}, env = process.env) {
  return env.INBOX_DIRECT_R2_VIDEO_ENABLED === "true" &&
    query?.delivery !== "proxy" &&
    Boolean(mediaRef?.media_key) &&
    String(mediaRef?.media_mime_type || "").split(";")[0].trim().toLowerCase() === "video/mp4";
}

async function tryDirectInboxVideo({ mediaRef, query, res, storage, env = process.env }) {
  if (!shouldTryDirectInboxVideo(mediaRef, query, env)) return false;
  // A database reference and the contact-level access check in the route are
  // mandatory. Refuse cross-client prefixes; legacy and shared follow-up keys
  // are deliberately accepted by the existing ownership helper.
  if (!storage.isOwnedStoredMediaKey(mediaRef.media_key, env)) return false;

  try {
    const head = await storage.headMediaObject(mediaRef.media_key);
    // Respect the actual object's MIME type: don't force an octet-stream or
    // mislabeled legacy object into cross-origin Safari video playback.
    if (head.mimeType !== "video/mp4" || !(head.bytes > 0)) return false;
    const url = storage.createPresignedGetUrl(mediaRef.media_key, {
      expiresSeconds: VIDEO_URL_TTL_SECONDS,
    });
    res.set({
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.redirect(302, url);
    return true;
  } catch (err) {
    // Never log the object key, signed URL, phone number or patient data.
    console.warn("[Inbox direct-R2 video] Using authenticated Render fallback", {
      reason: String(err?.code || err?.name || "unknown").slice(0, 64),
    });
    return false;
  }
}

module.exports = {
  VIDEO_URL_TTL_SECONDS,
  shouldTryDirectInboxVideo,
  tryDirectInboxVideo,
};
