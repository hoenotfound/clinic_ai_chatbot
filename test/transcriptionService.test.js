const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_TRANSCRIPTION_MODEL,
  buildUploadedAudioPart,
  getTranscriptionModel,
  normalizeAudioMimeType,
  prepareAudioForTranscription,
  runTranscription,
  waitForUploadedFileActive,
} = require("../src/services/transcriptionService");

test("voice transcription defaults to the dedicated Gemini 3.5 Transcribe model", () => {
  assert.equal(DEFAULT_TRANSCRIPTION_MODEL, "gemini-3.5-transcribe");
  assert.equal(getTranscriptionModel({}), "gemini-3.5-transcribe");
  assert.equal(
    getTranscriptionModel({ GEMINI_MODEL: "gemini-3.8-flash" }),
    "gemini-3.5-transcribe"
  );
  assert.equal(
    getTranscriptionModel({ GEMINI_TRANSCRIBE_MODEL: "gemini-3.5-transcribe" }),
    "gemini-3.5-transcribe"
  );
});

test("normalizes WhatsApp audio MIME types before upload", () => {
  assert.equal(normalizeAudioMimeType("audio/ogg; codecs=opus"), "audio/ogg");
  assert.equal(normalizeAudioMimeType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeAudioMimeType(""), "audio/ogg");
});

test("WhatsApp OGG/Opus is converted to a clean MP3 before Gemini upload", async () => {
  const source = Buffer.from("raw-whatsapp-ogg");
  let converterInput = null;
  const prepared = await prepareAudioForTranscription(
    source,
    "audio/ogg; codecs=opus",
    {
      async convertToMp3Fn(buffer) {
        converterInput = buffer;
        return { buffer: Buffer.from("clean-mp3"), mimeType: "audio/mpeg" };
      },
    }
  );

  assert.equal(converterInput, source);
  assert.equal(prepared.buffer.toString(), "clean-mp3");
  assert.equal(prepared.mimeType, "audio/mpeg");
});

test("non-WhatsApp audio bypasses FFmpeg normalization", async () => {
  const source = Buffer.from("already-mp3");
  let converted = false;
  const prepared = await prepareAudioForTranscription(source, "audio/mpeg", {
    async convertToMp3Fn() {
      converted = true;
      return null;
    },
  });

  assert.equal(converted, false);
  assert.equal(prepared.buffer, source);
  assert.equal(prepared.mimeType, "audio/mpeg");
});

test("failed local audio normalization stops before any Gemini key is used", async () => {
  await assert.rejects(
    prepareAudioForTranscription(Buffer.from("voice"), "audio/ogg", {
      async convertToMp3Fn() {
        return null;
      },
    }),
    (err) => {
      assert.equal(err.code, "AUDIO_NORMALIZATION_FAILED");
      assert.equal(err.stopGeminiKeyRotation, true);
      return true;
    }
  );
});

test("builds an explicit fileData part compatible with the pinned Gemini SDK", () => {
  assert.deepEqual(
    buildUploadedAudioPart(
      {
        uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
        mimeType: "audio/mpeg",
      },
      "audio/mpeg"
    ),
    {
      fileData: {
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
        mimeType: "audio/mpeg",
      },
    }
  );

  assert.throws(
    () => buildUploadedAudioPart({ mimeType: "audio/mpeg" }, "audio/mpeg"),
    /did not return a usable file URI/
  );
});

test("waits for a PROCESSING Gemini upload to become ACTIVE before inference", async () => {
  let nowMs = 0;
  const sleeps = [];
  const gets = [];
  const processingFile = {
    name: "files/processing-test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/processing-test",
    mimeType: "audio/mpeg",
    state: "PROCESSING",
  };
  const activeFile = { ...processingFile, state: "ACTIVE" };

  const ready = await waitForUploadedFileActive(
    {
      files: {
        async get(args) {
          gets.push(args);
          return activeFile;
        },
      },
    },
    processingFile,
    {
      timeoutMs: 2000,
      pollIntervalMs: 250,
      clock: () => nowMs,
      async sleepFn(ms) {
        sleeps.push(ms);
        nowMs += ms;
      },
    }
  );

  assert.equal(ready.state, "ACTIVE");
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(gets, [{ name: "files/processing-test" }]);
});

test("file-processing timeout stops key rotation because the credential is not at fault", async () => {
  let nowMs = 0;
  const processingFile = {
    name: "files/slow-test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/slow-test",
    mimeType: "audio/mpeg",
    state: "PROCESSING",
  };

  await assert.rejects(
    waitForUploadedFileActive(
      {
        files: {
          async get() {
            return processingFile;
          },
        },
      },
      processingFile,
      {
        timeoutMs: 500,
        pollIntervalMs: 250,
        clock: () => nowMs,
        async sleepFn(ms) {
          nowMs += ms;
        },
      }
    ),
    (err) => {
      assert.equal(err.code, "GEMINI_FILE_PROCESSING_TIMEOUT");
      assert.equal(err.stopGeminiKeyRotation, true);
      return true;
    }
  );
});

test("FAILED Gemini file processing stops before model inference", async () => {
  const failedFile = {
    name: "files/failed-test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/failed-test",
    mimeType: "audio/mpeg",
    state: "FAILED",
  };

  await assert.rejects(
    waitForUploadedFileActive(
      { files: { async get() { return failedFile; } } },
      failedFile
    ),
    (err) => {
      assert.equal(err.code, "GEMINI_FILE_PROCESSING_FAILED");
      assert.equal(err.stopGeminiKeyRotation, true);
      return true;
    }
  );
});

test("transcription normalizes once, waits for ACTIVE, sends MP3 fileData, and cleans up", async () => {
  const calls = {
    prepare: 0,
    upload: [],
    get: [],
    generate: [],
    delete: [],
  };
  const preparedBuffer = Buffer.from("clean-mp3");
  const uploadedFile = {
    name: "files/voice-test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
    mimeType: "audio/mpeg",
  };
  const activeFile = { ...uploadedFile, state: "ACTIVE" };

  const ai = {
    files: {
      async upload(args) {
        calls.upload.push(args);
        return uploadedFile;
      },
      async get(args) {
        calls.get.push(args);
        return activeFile;
      },
      async delete(args) {
        calls.delete.push(args);
      },
    },
  };

  const transcript = await runTranscription(
    Buffer.from("fake-voice-note"),
    "audio/ogg; codecs=opus",
    {
      env: {},
      async prepareAudio() {
        calls.prepare += 1;
        return { buffer: preparedBuffer, mimeType: "audio/mpeg" };
      },
      createClient(apiKey) {
        assert.equal(apiKey, "key-a");
        return ai;
      },
      async runWithKeys(operation, options) {
        assert.deepEqual(options, { retryCount: 1 });
        return operation("key-a");
      },
      async generateContent(client, request, options) {
        assert.equal(client, ai);
        calls.generate.push({ request, options });
        return { text: "Hi 想问 HIFU price, weekend ada slot tak?" };
      },
    }
  );

  assert.equal(transcript, "Hi 想问 HIFU price, weekend ada slot tak?");
  assert.equal(calls.prepare, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].file.type, "audio/mpeg");
  assert.equal(calls.upload[0].file.size, preparedBuffer.length);
  assert.deepEqual(calls.upload[0].config, { mimeType: "audio/mpeg" });
  assert.deepEqual(calls.get, [{ name: "files/voice-test" }]);

  assert.equal(calls.generate.length, 1);
  const { request, options } = calls.generate[0];
  assert.equal(request.model, "gemini-3.5-transcribe");
  assert.deepEqual(request.contents, [
    {
      fileData: {
        fileUri: activeFile.uri,
        mimeType: "audio/mpeg",
      },
    },
  ]);
  assert.equal(request.config.maxOutputTokens, 500);
  assert.deepEqual(request.config.audioTranscriptionConfig, {
    languageCodes: [],
    mode: "VERBATIM",
  });
  assert.equal(Object.hasOwn(request.config, "thinkingConfig"), false);
  assert.deepEqual(options, { purpose: "voice_transcription" });
  assert.deepEqual(calls.delete, [{ name: "files/voice-test" }]);
});

test("uploaded-file cleanup failure does not discard a successful transcript", async () => {
  const transcript = await runTranscription(
    Buffer.from("voice"),
    "audio/mpeg",
    {
      env: {},
      createClient() {
        return {
          files: {
            async upload() {
              return {
                name: "files/cleanup-test",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/cleanup-test",
                mimeType: "audio/mpeg",
                state: "ACTIVE",
              };
            },
            async get() {
              throw new Error("get should not be needed for an ACTIVE upload");
            },
            async delete() {
              throw new Error("cleanup unavailable");
            },
          },
        };
      },
      async runWithKeys(operation) {
        return operation("key-a");
      },
      async generateContent() {
        return { text: "boleh book esok?" };
      },
    }
  );

  assert.equal(transcript, "boleh book esok?");
});

test("missing upload URI fails safely instead of sending an empty Gemini content part", async () => {
  let generated = false;
  let deleted = false;
  const transcript = await runTranscription(
    Buffer.from("voice"),
    "audio/mpeg",
    {
      env: {},
      createClient() {
        return {
          files: {
            async upload() {
              return { name: "files/no-uri", mimeType: "audio/mpeg", state: "ACTIVE" };
            },
            async get() {
              throw new Error("get should not be needed for an ACTIVE upload");
            },
            async delete() {
              deleted = true;
            },
          },
        };
      },
      async runWithKeys(operation) {
        return operation("key-a");
      },
      async generateContent() {
        generated = true;
        return { text: "unexpected" };
      },
    }
  );

  assert.equal(transcript, null);
  assert.equal(generated, false);
  assert.equal(deleted, true);
});

test("empty audio is ignored without normalization or Gemini key usage", async () => {
  let prepared = false;
  let called = false;
  const transcript = await runTranscription(Buffer.alloc(0), "audio/ogg", {
    async prepareAudio() {
      prepared = true;
      return { buffer: Buffer.from("unexpected"), mimeType: "audio/mpeg" };
    },
    async runWithKeys() {
      called = true;
      return "unexpected";
    },
  });

  assert.equal(transcript, null);
  assert.equal(prepared, false);
  assert.equal(called, false);
});
