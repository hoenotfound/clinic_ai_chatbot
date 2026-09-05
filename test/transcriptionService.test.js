const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_INLINE_AUDIO_MAX_BYTES,
  DEFAULT_TRANSCRIPTION_MODEL,
  buildInlineInteractionAudioInput,
  buildInteractionAudioInput,
  createExactUploadBlob,
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

test("normal voice notes stay safely below the 20 MB inline request ceiling", () => {
  assert.equal(DEFAULT_INLINE_AUDIO_MAX_BYTES, 14 * 1024 * 1024);
  assert.ok(Math.ceil(DEFAULT_INLINE_AUDIO_MAX_BYTES / 3) * 4 < 20 * 1024 * 1024);
});

test("normalizes WhatsApp audio MIME types before transcription", () => {
  assert.equal(normalizeAudioMimeType("audio/ogg; codecs=opus"), "audio/ogg");
  assert.equal(normalizeAudioMimeType("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(normalizeAudioMimeType(""), "audio/ogg");
});

test("WhatsApp OGG/Opus is converted to a clean MP3 before Gemini transcription", async () => {
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

test("failed local MP3 normalization falls back to the original provider-supported audio", async () => {
  const source = Buffer.from("voice");
  const prepared = await prepareAudioForTranscription(source, "audio/ogg; codecs=opus", {
    async convertToMp3Fn() {
      return null;
    },
  });

  assert.equal(prepared.buffer, source);
  assert.equal(prepared.mimeType, "audio/ogg");
});

test("builds inline Interactions audio from the exact prepared bytes", () => {
  const audio = Buffer.from([0, 1, 2, 253, 254, 255]);
  assert.deepEqual(
    buildInlineInteractionAudioInput(audio, "audio/mpeg; codecs=mp3"),
    {
      type: "audio",
      data: audio.toString("base64"),
      mime_type: "audio/mpeg",
    }
  );

  assert.throws(
    () => buildInlineInteractionAudioInput(Buffer.alloc(0), "audio/mpeg"),
    /empty or invalid/
  );
});

test("builds the current Interactions API uploaded-audio input shape", () => {
  assert.deepEqual(
    buildInteractionAudioInput(
      {
        uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
        mimeType: "audio/mpeg",
      },
      "audio/mpeg"
    ),
    {
      type: "audio",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
      mime_type: "audio/mpeg",
    }
  );

  assert.throws(
    () => buildInteractionAudioInput({ mimeType: "audio/mpeg" }, "audio/mpeg"),
    /did not return a usable file URI/
  );
});

test("large-file Blob contains only an offset Buffer view's intended bytes", async () => {
  const expected = Buffer.from("voice-bytes");
  const backing = Buffer.alloc(64, 0x7a);
  expected.copy(backing, 17);
  const offsetView = backing.subarray(17, 17 + expected.length);

  assert.ok(offsetView.byteOffset > 0);
  const blob = createExactUploadBlob(offsetView, "audio/mpeg");
  assert.equal(blob.type, "audio/mpeg");
  assert.equal(blob.size, expected.length);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), expected);
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

test("normal transcription uses inline audio and completely skips Files API processing", async () => {
  const calls = {
    prepare: 0,
    interaction: [],
    files: 0,
  };
  const preparedBuffer = Buffer.from("clean-inline-mp3");
  const ai = {
    files: {
      async upload() {
        calls.files += 1;
        throw new Error("normal voice note must not use Files API");
      },
      async get() {
        calls.files += 1;
        throw new Error("normal voice note must not poll Files API");
      },
      async delete() {
        calls.files += 1;
        throw new Error("normal voice note must not delete a nonexistent upload");
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
      async createInteraction(client, request, options) {
        assert.equal(client, ai);
        calls.interaction.push({ request, options });
        return { output_text: "Hi 想问 HIFU price, weekend ada slot tak?" };
      },
    }
  );

  assert.equal(transcript, "Hi 想问 HIFU price, weekend ada slot tak?");
  assert.equal(calls.prepare, 1);
  assert.equal(calls.files, 0);
  assert.equal(calls.interaction.length, 1);
  assert.deepEqual(calls.interaction[0], {
    request: {
      model: "gemini-3.5-transcribe",
      input: [
        {
          type: "audio",
          data: preparedBuffer.toString("base64"),
          mime_type: "audio/mpeg",
        },
      ],
    },
    options: { purpose: "voice_transcription" },
  });
});

test("large transcription keeps Files API fallback, waits for ACTIVE, and cleans up", async () => {
  const calls = {
    prepare: 0,
    upload: [],
    get: [],
    interaction: [],
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
      inlineAudioMaxBytes: 0,
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
      async createInteraction(client, request, options) {
        assert.equal(client, ai);
        calls.interaction.push({ request, options });
        return { output_text: "Hi 想问 HIFU price, weekend ada slot tak?" };
      },
    }
  );

  assert.equal(transcript, "Hi 想问 HIFU price, weekend ada slot tak?");
  assert.equal(calls.prepare, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].file.type, "audio/mpeg");
  assert.equal(calls.upload[0].file.size, preparedBuffer.length);
  assert.deepEqual(
    Buffer.from(await calls.upload[0].file.arrayBuffer()),
    preparedBuffer
  );
  assert.deepEqual(calls.upload[0].config, { mimeType: "audio/mpeg" });
  assert.deepEqual(calls.get, [{ name: "files/voice-test" }]);

  assert.equal(calls.interaction.length, 1);
  const { request, options } = calls.interaction[0];
  assert.deepEqual(request, {
    model: "gemini-3.5-transcribe",
    input: [
      {
        type: "audio",
        uri: activeFile.uri,
        mime_type: "audio/mpeg",
      },
    ],
  });
  assert.deepEqual(options, { purpose: "voice_transcription" });
  assert.deepEqual(calls.delete, [{ name: "files/voice-test" }]);
});

test("transcription never reads the legacy GenerateContent response.text getter", async () => {
  let legacyTextRead = false;
  const transcript = await runTranscription(Buffer.from("voice"), "audio/mpeg", {
    env: {},
    createClient() {
      return { files: {} };
    },
    async runWithKeys(operation) {
      return operation("key-a");
    },
    async createInteraction() {
      return {
        output_text: "works without audioTranscription warning",
        get text() {
          legacyTextRead = true;
          throw new Error("legacy response.text must never be accessed");
        },
      };
    },
  });

  assert.equal(transcript, "works without audioTranscription warning");
  assert.equal(legacyTextRead, false);
});

test("uploaded-file cleanup failure does not discard a successful large-file transcript", async () => {
  const transcript = await runTranscription(
    Buffer.from("voice"),
    "audio/mpeg",
    {
      env: {},
      inlineAudioMaxBytes: 0,
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
      async createInteraction() {
        return { output_text: "boleh book esok?" };
      },
    }
  );

  assert.equal(transcript, "boleh book esok?");
});

test("missing large-file upload URI fails safely instead of sending invalid interaction input", async () => {
  let interacted = false;
  let deleted = false;
  const transcript = await runTranscription(
    Buffer.from("voice"),
    "audio/mpeg",
    {
      env: {},
      inlineAudioMaxBytes: 0,
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
      async createInteraction() {
        interacted = true;
        return { output_text: "unexpected" };
      },
    }
  );

  assert.equal(transcript, null);
  assert.equal(interacted, false);
  assert.equal(deleted, true);
});

test("empty Interactions output returns null without throwing", async () => {
  const transcript = await runTranscription(Buffer.from("voice"), "audio/mpeg", {
    env: {},
    createClient() {
      return { files: {} };
    },
    async runWithKeys(operation) {
      return operation("key-a");
    },
    async createInteraction() {
      return { output_text: "" };
    },
  });

  assert.equal(transcript, null);
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
