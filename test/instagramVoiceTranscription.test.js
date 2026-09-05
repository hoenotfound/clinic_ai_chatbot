const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isDeterministicTranscriptionMediaError,
  markDeterministicTranscriptionMediaError,
  needsMp3Normalization,
  prepareAudioForTranscription,
} = require("../src/services/transcriptionService");

test("Instagram voice MIME mislabeled as video is normalized before Gemini", async () => {
  const source = Buffer.from("instagram-audio-only-mp4");
  let converterInput = null;

  const prepared = await prepareAudioForTranscription(source, "video/mp4", {
    async convertToMp3Fn(buffer) {
      converterInput = buffer;
      return {
        buffer: Buffer.from("normalized-instagram-mp3"),
        mimeType: "audio/mpeg",
      };
    },
  });

  assert.equal(converterInput, source);
  assert.equal(prepared.buffer.toString(), "normalized-instagram-mp3");
  assert.equal(prepared.mimeType, "audio/mpeg");
});

test("generic Meta CDN MIME is normalized while valid audio MIME stays direct", () => {
  assert.equal(needsMp3Normalization("video/mp4"), true);
  assert.equal(needsMp3Normalization("application/octet-stream"), true);
  assert.equal(needsMp3Normalization("audio/ogg; codecs=opus"), true);
  assert.equal(needsMp3Normalization("audio/opus"), true);
  assert.equal(needsMp3Normalization("audio/mpeg"), false);
  assert.equal(needsMp3Normalization("audio/mp4"), false);
  assert.equal(needsMp3Normalization("audio/webm"), false);
});

test("non-audio MIME never falls through to Gemini when local normalization fails", async () => {
  await assert.rejects(
    prepareAudioForTranscription(Buffer.from("voice"), "video/mp4", {
      async convertToMp3Fn() {
        return null;
      },
    }),
    (err) => {
      assert.equal(err.code, "AUDIO_NORMALIZATION_FAILED");
      assert.equal(err.stopGeminiKeyRotation, true);
      assert.match(err.message, /video\/mp4/);
      return true;
    }
  );
});

test("Gemini zero-frame media validation error is deterministic and stops key rotation", () => {
  const err = new Error(
    "400 The video is corrupted or has wrong video metadata. 0 Frames found."
  );

  assert.equal(isDeterministicTranscriptionMediaError(err), true);
  assert.equal(err.stopGeminiKeyRotation, undefined);

  const marked = markDeterministicTranscriptionMediaError(err);
  assert.equal(marked, err);
  assert.equal(err.stopGeminiKeyRotation, true);
});

test("ordinary transient provider errors are not mislabeled as media failures", () => {
  const err = new Error("503 Service unavailable");
  assert.equal(isDeterministicTranscriptionMediaError(err), false);
  markDeterministicTranscriptionMediaError(err);
  assert.equal(err.stopGeminiKeyRotation, undefined);
});
