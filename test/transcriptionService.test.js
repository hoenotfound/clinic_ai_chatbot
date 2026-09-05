const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_TRANSCRIPTION_MODEL,
  buildUploadedAudioPart,
  getTranscriptionModel,
  normalizeAudioMimeType,
  runTranscription,
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

test("builds an explicit fileData part compatible with the pinned Gemini SDK", () => {
  assert.deepEqual(
    buildUploadedAudioPart(
      {
        uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
        mimeType: "audio/ogg; codecs=opus",
      },
      "audio/webm"
    ),
    {
      fileData: {
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
        mimeType: "audio/ogg",
      },
    }
  );

  assert.throws(
    () => buildUploadedAudioPart({ mimeType: "audio/ogg" }, "audio/ogg"),
    /did not return a usable file URI/
  );
});

test("transcription uploads audio, sends explicit fileData, uses verbatim auto-language detection, and cleans up", async () => {
  const calls = {
    upload: [],
    generate: [],
    delete: [],
  };
  const uploadedFile = {
    name: "files/voice-test",
    uri: "https://generativelanguage.googleapis.com/v1beta/files/voice-test",
    mimeType: "audio/ogg",
  };

  const ai = {
    files: {
      async upload(args) {
        calls.upload.push(args);
        return uploadedFile;
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
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].file.type, "audio/ogg");
  assert.equal(calls.upload[0].file.size, Buffer.byteLength("fake-voice-note"));
  assert.deepEqual(calls.upload[0].config, { mimeType: "audio/ogg" });

  assert.equal(calls.generate.length, 1);
  const { request, options } = calls.generate[0];
  assert.equal(request.model, "gemini-3.5-transcribe");
  assert.deepEqual(request.contents, [
    {
      fileData: {
        fileUri: uploadedFile.uri,
        mimeType: "audio/ogg",
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
    "audio/ogg",
    {
      env: {},
      createClient() {
        return {
          files: {
            async upload() {
              return {
                name: "files/cleanup-test",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/cleanup-test",
                mimeType: "audio/ogg",
              };
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
    "audio/ogg",
    {
      env: {},
      createClient() {
        return {
          files: {
            async upload() {
              return { name: "files/no-uri", mimeType: "audio/ogg" };
            },
            async delete() {
              deleted = true;
            },
          },
        };
      },
      async runWithKeys(operation) {
        try {
          return await operation("key-a");
        } catch (err) {
          throw err;
        }
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

test("empty audio is ignored without touching the Gemini key pool", async () => {
  let called = false;
  const transcript = await runTranscription(Buffer.alloc(0), "audio/ogg", {
    async runWithKeys() {
      called = true;
      return "unexpected";
    },
  });

  assert.equal(transcript, null);
  assert.equal(called, false);
});
