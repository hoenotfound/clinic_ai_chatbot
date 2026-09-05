const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("runtime background services no longer default to retired Gemini 2.5 Flash", () => {
  const runtimeFiles = [
    "src/services/leadScoringAiService.js",
    "src/services/followUpTranslationService.js",
    "src/services/transcriptionService.js",
  ];

  for (const file of runtimeFiles) {
    assert.doesNotMatch(source(file), /gemini-2\.5-flash/);
  }
});

test("WhatsApp OGG transcription reuses the existing FFmpeg MP3 normalizer", () => {
  const transcriptionSource = source("src/services/transcriptionService.js");
  assert.match(transcriptionSource, /convertToMp3/);
  assert.match(transcriptionSource, /audio\/ogg/);
  assert.match(transcriptionSource, /audio\/mpeg/);
});
