"use strict";

const crypto = require("node:crypto");
const { hasTreatmentPriceContent } = require("./initialOfferReplyGuard");
const { hasUnsafeClinicalPromotionCopy } = require("./promotionClinicalCopyPolicy");

const VOICE_LANGUAGES = ["zh", "en", "ms"];
const MAX_TRANSCRIPT_LENGTH = 1000;
const MAX_VOICE_SECONDS = 120;

function voiceTranscriptDigest(transcript, language, previewKey) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([String(transcript).trim(), language, previewKey]))
    .digest("hex");
}

function unsafeVoiceTranscript(transcript) {
  const text = String(transcript || "").trim();
  return !text || text.length > MAX_TRANSCRIPT_LENGTH ||
    hasTreatmentPriceContent(text) || hasUnsafeClinicalPromotionCopy(text);
}

function validVoiceAssetKey(key, extension, mediaStorage) {
  if (typeof key !== "string" || !key || key.length > 1024 || key.includes("..")) return false;
  return key.startsWith(mediaStorage.followUpConfigVideoPrefix()) &&
    mediaStorage.isOwnedStoredMediaKey(key) &&
    key.toLowerCase().endsWith("." + extension);
}

function normalizeVoiceNotes(value, mediaStorage) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(language => !VOICE_LANGUAGES.includes(language))) return null;
  const result = {};
  for (const language of VOICE_LANGUAGES) {
    const input = value[language];
    if (input === undefined || input === null) continue;
    if (typeof input !== "object" || Array.isArray(input) ||
        input.approved !== true ||
        !validVoiceAssetKey(input.key, "ogg", mediaStorage) ||
        !validVoiceAssetKey(input.previewKey, "mp3", mediaStorage) ||
        unsafeVoiceTranscript(input.transcript) ||
        (input.language !== undefined && input.language !== language) ||
        typeof input.filename !== "string" || input.filename.length > 255) return null;
    result[language] = {
      key: input.key,
      previewKey: input.previewKey,
      transcript: String(input.transcript).trim(),
      filename: input.filename,
      approved: true,
    };
  }
  return result;
}

function voiceNotesPresent(notes) {
  return Boolean(notes && typeof notes === "object" && VOICE_LANGUAGES.some(lang => notes[lang]?.key));
}

function selectedVoiceNote(notes, language) {
  const note = notes?.[language];
  return note?.approved === true && !unsafeVoiceTranscript(note.transcript) ? note : null;
}

function isVoiceAssetMetadataValid(info, note, language) {
  if (!note || !info || info.mimeType !== "audio/ogg" ||
      !Number.isFinite(info.bytes) || info.bytes <= 0 || info.bytes > 8 * 1024 * 1024) return false;
  return info.metadata?.voicelanguage === language &&
    info.metadata?.voicepreviewkey === note.previewKey &&
    info.metadata?.voicetranscripthash === voiceTranscriptDigest(note.transcript, language, note.previewKey);
}

module.exports = {
  VOICE_LANGUAGES, MAX_TRANSCRIPT_LENGTH, MAX_VOICE_SECONDS,
  voiceTranscriptDigest, unsafeVoiceTranscript, validVoiceAssetKey,
  normalizeVoiceNotes, voiceNotesPresent, selectedVoiceNote, isVoiceAssetMetadataValid,
};
