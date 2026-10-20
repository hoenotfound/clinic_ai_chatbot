"use strict";

const {
  validVoiceAssetKey,
  isVoiceAssetMetadataValid,
} = require("../utils/followUpVoicePolicy");

const AUTOMATED_VOICE_TRANSCRIPT = /^🎤 \[Automated voice note, (zh|en|ms); transcript\] ([\s\S]+)$/u;

/**
 * An authenticated conversation owns the original OGG attachment. Its
 * R2 upload metadata links it to a verified MP3 playback copy. Never give
 * the browser a key supplied by a query parameter or unverified message.
 * Historical messages remain playable after staff replace configured notes.
 */
async function resolveAutomatedVoicePlayback(mediaRef, storage) {
  const key = mediaRef?.media_key;
  if (mediaRef?.is_automated_follow_up !== true ||
      mediaRef?.media_mime_type !== "audio/ogg" ||
      !validVoiceAssetKey(key, "ogg", storage)) return null;

  const match = String(mediaRef.content || "").match(AUTOMATED_VOICE_TRANSCRIPT);
  if (!match) return null;
  const [, language, transcript] = match;

  const voice = await storage.getSharedFollowUpMediaInfo(key);
  const previewKey = String(voice?.metadata?.voicepreviewkey || "");
  if (!validVoiceAssetKey(previewKey, "mp3", storage) ||
      !isVoiceAssetMetadataValid(voice, { previewKey, transcript }, language)) {
    return null;
  }

  const preview = await storage.getSharedFollowUpMediaInfo(previewKey);
  if (preview.mimeType !== "audio/mpeg" ||
      !Number.isFinite(preview.bytes) || preview.bytes <= 0 ||
      preview.bytes > 16 * 1024 * 1024) return null;

  return { key: previewKey, mimeType: "audio/mpeg" };
}

module.exports = { resolveAutomatedVoicePlayback, AUTOMATED_VOICE_TRANSCRIPT };
