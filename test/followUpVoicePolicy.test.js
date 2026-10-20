"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const storage = require("../src/services/mediaStorageService");
const {
  normalizeVoiceNotes, selectedVoiceNote, unsafeVoiceTranscript,
  voiceTranscriptDigest, isVoiceAssetMetadataValid, validVoiceAssetKey,
} = require("../src/utils/followUpVoicePolicy");

test("voice language selection never falls back to the wrong language", () => {
  const notes = { zh: { key: "zh.ogg", transcript: "您好", approved: true } };
  assert.equal(selectedVoiceNote(notes, "en"), null);
  assert.equal(selectedVoiceNote(notes, "ms"), null);
  assert.equal(selectedVoiceNote(notes, "zh")?.transcript, "您好");
});

test("voice transcript policy blocks prices and unsafe guarantees", () => {
  assert.equal(unsafeVoiceTranscript(""), true);
  assert.equal(unsafeVoiceTranscript("First trial only RM488."), true);
  assert.equal(unsafeVoiceTranscript("Guaranteed results with no side effects."), true);
  assert.equal(unsafeVoiceTranscript("Let's arrange an assessment first."), false);
});

test("configured voice must match the exact upload transcript, language and preview", () => {
  const transcript = "Hello, can we arrange a quick assessment?";
  const previewKey = "clients/test/messages/follow-up-config/preview.mp3";
  const note = { previewKey, transcript };
  const info = {
    mimeType: "audio/ogg", bytes: 500,
    metadata: {
      voicelanguage: "en",
      voicepreviewkey: previewKey,
      voicetranscripthash: voiceTranscriptDigest(transcript, "en", previewKey),
    },
  };
  assert.equal(isVoiceAssetMetadataValid(info, note, "en"), true);
  assert.equal(isVoiceAssetMetadataValid(info, { ...note, transcript: "Different spoken message" }, "en"), false);
  assert.equal(isVoiceAssetMetadataValid(info, note, "ms"), false);
  assert.equal(isVoiceAssetMetadataValid({ ...info, mimeType: "audio/mpeg" }, note, "en"), false);
});

test("legacy unscoped recording keys and unapproved recordings cannot activate", () => {
  const previousSlug = process.env.CLIENT_SLUG;
  try {
    process.env.CLIENT_SLUG = "clinic-test";
    const key = `${storage.followUpConfigVideoPrefix()}a.ogg`;
    const previewKey = `${storage.followUpConfigVideoPrefix()}a.mp3`;
    const valid = { key, previewKey, filename: "voice.mp3", transcript: "Please visit for an assessment.", approved: true };
    assert.equal(validVoiceAssetKey(key, "ogg", storage), true);
    assert.equal(validVoiceAssetKey("messages/follow-up-config/a.ogg", "ogg", storage), false);
    assert.equal(normalizeVoiceNotes({ en: valid }, storage).en.key, key);
    assert.equal(normalizeVoiceNotes({ en: { ...valid, approved: false } }, storage), null);
    assert.equal(normalizeVoiceNotes({ de: valid }, storage), null);
    process.env.CLIENT_SLUG = "";
    assert.equal(validVoiceAssetKey(key, "ogg", storage), false);
  } finally {
    if (previousSlug === undefined) delete process.env.CLIENT_SLUG;
    else process.env.CLIENT_SLUG = previousSlug;
  }
});
