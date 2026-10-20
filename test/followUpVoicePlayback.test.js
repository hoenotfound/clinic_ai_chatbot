"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const storage = require("../src/services/mediaStorageService");
const { voiceTranscriptDigest } = require("../src/utils/followUpVoicePolicy");
const { resolveAutomatedVoicePlayback } = require("../src/services/followUpVoicePlaybackService");

test("Inbox uses a verified MP3 for automated voice, independent of current saved config", async () => {
  const previous = process.env.CLIENT_SLUG;
  process.env.CLIENT_SLUG = "voice-policy-test";
  try {
    const prefix = storage.followUpConfigVideoPrefix();
    const key = prefix + "note.ogg";
    const previewKey = prefix + "preview.mp3";
    const transcript = "Hello, please come for an assessment.";
    const message = {
      is_automated_follow_up: true,
      media_mime_type: "audio/ogg",
      media_key: key,
      content: `🎤 [Automated voice note, en; transcript] ${transcript}`,
    };
    const getSharedFollowUpMediaInfo = async (reference) => {
      if (reference === key) return {
        mimeType: "audio/ogg", bytes: 5000,
        metadata: {
          voicelanguage: "en", voicepreviewkey: previewKey,
          voicetranscripthash: voiceTranscriptDigest(transcript, "en", previewKey),
        },
      };
      if (reference === previewKey) return { mimeType: "audio/mpeg", bytes: 6500 };
      throw Error("Unexpected storage key");
    };
    const actual = await resolveAutomatedVoicePlayback(message, {
      ...storage, getSharedFollowUpMediaInfo,
    });
    assert.deepEqual(actual, { key: previewKey, mimeType: "audio/mpeg" });
    assert.equal(await resolveAutomatedVoicePlayback(
      { ...message, content: message.content.replace("assessment", "surgery") },
      { ...storage, getSharedFollowUpMediaInfo }
    ), null);
    assert.equal(await resolveAutomatedVoicePlayback(
      { ...message, is_automated_follow_up: false },
      { ...storage, getSharedFollowUpMediaInfo }
    ), null);
    assert.equal(await resolveAutomatedVoicePlayback(
      { ...message, media_key: "messages/follow-up-config/note.ogg" },
      { ...storage, getSharedFollowUpMediaInfo }
    ), null);
    assert.equal(await resolveAutomatedVoicePlayback(
      message, { ...storage, getSharedFollowUpMediaInfo: async ref => ref === key
        ? getSharedFollowUpMediaInfo(ref) : { mimeType: "audio/ogg", bytes: 200 } }
    ), null);
  } finally {
    if (previous === undefined) delete process.env.CLIENT_SLUG;
    else process.env.CLIENT_SLUG = previous;
  }
});

test("both follow-up voice editor and Inbox route use the verified MP3 path", () => {
  const route = fs.readFileSync(path.join(__dirname, "../src/routes/conversations.js"), "utf8");
  const repo = fs.readFileSync(path.join(__dirname, "../src/db/messagesRepo.js"), "utf8");
  const frontend = fs.readFileSync(path.join(__dirname, "../portal-frontend/src/pages/Tools.jsx"), "utf8");
  assert.match(route, /resolveAutomatedVoicePlayback\(mediaRef, mediaStorage\)/);
  assert.match(route, /voicePlayback\?\.key \|\| mediaRef\.media_key/);
  assert.match(repo, /is_automated_follow_up, content\s+FROM messages/u);
  assert.match(frontend, /voicePreviewUrls\[previewVoiceNote\.previewKey\]/);
  assert.match(frontend, /setVoicePreviewUrls\(\{\}\)/);
});
