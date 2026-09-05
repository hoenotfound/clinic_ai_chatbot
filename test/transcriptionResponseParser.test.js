const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractTranscriptionText,
} = require("../src/services/transcriptionService");

test("reads Gemini 3.5 structured audioTranscription parts without touching response.text", () => {
  let topLevelTextRead = false;
  const response = {
    candidates: [{
      content: {
        parts: [
          { audioTranscription: { text: "Hi 想问 HIFU price" } },
          { audioTranscription: { text: ", weekend ada slot tak?" } },
        ],
      },
    }],
    get text() {
      topLevelTextRead = true;
      throw new Error("response.text must not be read for structured transcription parts");
    },
  };

  assert.equal(
    extractTranscriptionText(response),
    "Hi 想问 HIFU price, weekend ada slot tak?"
  );
  assert.equal(topLevelTextRead, false);
});

test("falls back to ordinary candidate text parts without using response.text", () => {
  let topLevelTextRead = false;
  const response = {
    candidates: [{
      content: {
        parts: [{ text: "boleh " }, { text: "book esok?" }],
      },
    }],
    get text() {
      topLevelTextRead = true;
      throw new Error("response.text should not be needed when candidate text parts exist");
    },
  };

  assert.equal(extractTranscriptionText(response), "boleh book esok?");
  assert.equal(topLevelTextRead, false);
});

test("keeps compatibility with legacy responses that only expose response.text", () => {
  assert.equal(
    extractTranscriptionText({ text: "legacy transcript" }),
    "legacy transcript"
  );
});

test("structured non-text parts without transcript text return empty instead of triggering SDK helper", () => {
  let topLevelTextRead = false;
  const response = {
    candidates: [{
      content: {
        parts: [{ audioTranscription: {} }],
      },
    }],
    get text() {
      topLevelTextRead = true;
      throw new Error("response.text must not be read for structured non-text parts");
    },
  };

  assert.equal(extractTranscriptionText(response), "");
  assert.equal(topLevelTextRead, false);
});
