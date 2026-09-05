const { Blob } = require("node:buffer");
const { GoogleGenAI } = require("@google/genai");
const { createGeminiInteraction } = require("./aiUsageService");
const { convertToMp3 } = require("./audioConvertService");
const { runWithGeminiKeys } = require("./geminiKeyPool");

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";
const DEFAULT_FILE_PROCESSING_TIMEOUT_MS = 10 * 1000;
const DEFAULT_FILE_PROCESSING_POLL_INTERVAL_MS = 250;
// Interactions requests allow up to 20 MB total for inline audio. Base64 expands
// binary data by roughly 4/3, so keep a conservative raw-audio ceiling below
// that request limit. Normal WhatsApp voice notes are far smaller than this.
const DEFAULT_INLINE_AUDIO_MAX_BYTES = 14 * 1024 * 1024;
const LOSSY_WHATSAPP_MIME_TYPES = new Set(["audio/ogg", "audio/opus"]);

function getTranscriptionModel(env = process.env) {
  return String(env.GEMINI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIPTION_MODEL).trim()
    || DEFAULT_TRANSCRIPTION_MODEL;
}

function normalizeAudioMimeType(mimeType) {
  return String(mimeType || "audio/ogg").split(";")[0].trim().toLowerCase() || "audio/ogg";
}

function normalizeFileState(file) {
  return String(file?.state || "").trim().toUpperCase();
}

function createFileProcessingError(message, code) {
  const err = new Error(message);
  err.code = code;
  // PROCESSING/FAILED is a property of this uploaded file, not evidence that
  // the API credential is unhealthy. Do not burn through every Gemini key for
  // the same file-lifecycle condition.
  err.stopGeminiKeyRotation = true;
  return err;
}

async function prepareAudioForTranscription(
  audioBuffer,
  mimeType,
  { convertToMp3Fn = convertToMp3 } = {}
) {
  const normalizedMimeType = normalizeAudioMimeType(mimeType);
  if (!LOSSY_WHATSAPP_MIME_TYPES.has(normalizedMimeType)) {
    return { buffer: audioBuffer, mimeType: normalizedMimeType };
  }

  // WhatsApp voice notes are normally Ogg/Opus. Normalize them to the app's
  // proven MP3 representation before transcription so Gemini receives a simple,
  // consistent speech container regardless of the original Meta voice note.
  const converted = await convertToMp3Fn(audioBuffer);
  if (!converted?.buffer || !Buffer.isBuffer(converted.buffer) || converted.buffer.length === 0) {
    console.warn(
      "Could not normalize voice audio to MP3; falling back to the original audio for transcription."
    );
    return { buffer: audioBuffer, mimeType: normalizedMimeType };
  }

  return {
    buffer: converted.buffer,
    mimeType: normalizeAudioMimeType(converted.mimeType || "audio/mpeg"),
  };
}

async function waitForUploadedFileActive(
  ai,
  uploadedFile,
  {
    timeoutMs = DEFAULT_FILE_PROCESSING_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_FILE_PROCESSING_POLL_INTERVAL_MS,
    clock = () => Date.now(),
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}
) {
  const name = String(uploadedFile?.name || "").trim();
  if (!name || !ai?.files?.get) {
    throw createFileProcessingError(
      "Gemini Files API upload could not be checked for readiness.",
      "INVALID_AI_RESPONSE"
    );
  }

  let currentFile = uploadedFile;
  const startedAt = clock();
  let firstFetch = true;

  while (true) {
    const state = normalizeFileState(currentFile);
    if (state === "ACTIVE") return currentFile;
    if (state === "FAILED") {
      throw createFileProcessingError(
        `Gemini Files API could not process uploaded audio ${name}.`,
        "GEMINI_FILE_PROCESSING_FAILED"
      );
    }

    const elapsedMs = Math.max(0, clock() - startedAt);
    if (elapsedMs >= timeoutMs) {
      throw createFileProcessingError(
        `Gemini Files API audio ${name} did not become ACTIVE within ${timeoutMs}ms.`,
        "GEMINI_FILE_PROCESSING_TIMEOUT"
      );
    }

    // Some SDK responses omit state on the immediate upload result. In that
    // case fetch metadata straight away. When Google explicitly says the file
    // is PROCESSING, give it a short bounded interval before checking again.
    if (!firstFetch || state === "PROCESSING") {
      const remainingMs = Math.max(1, timeoutMs - elapsedMs);
      await sleepFn(Math.min(pollIntervalMs, remainingMs));
    }

    currentFile = await ai.files.get({ name });
    firstFetch = false;
  }
}

function buildInteractionAudioInput(uploadedFile, fallbackMimeType) {
  const uri = String(uploadedFile?.uri || "").trim();
  if (!uri) {
    const err = new Error("Gemini Files API upload did not return a usable file URI.");
    err.code = "INVALID_AI_RESPONSE";
    throw err;
  }

  return {
    type: "audio",
    uri,
    mime_type: normalizeAudioMimeType(uploadedFile?.mimeType || fallbackMimeType),
  };
}

function buildInlineInteractionAudioInput(audioBuffer, mimeType) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    const err = new Error("Inline Gemini transcription audio is empty or invalid.");
    err.code = "INVALID_AI_RESPONSE";
    throw err;
  }

  return {
    type: "audio",
    data: audioBuffer.toString("base64"),
    mime_type: normalizeAudioMimeType(mimeType),
  };
}

function createExactUploadBlob(audioBuffer, mimeType) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    const err = new Error("Gemini transcription upload audio is empty or invalid.");
    err.code = "INVALID_AI_RESPONSE";
    throw err;
  }

  // Node Buffers can be views into a larger pooled ArrayBuffer. Copy into a
  // standalone Uint8Array before constructing a Blob so multipart upload never
  // includes bytes outside this audio Buffer's byteOffset/byteLength window.
  const exactBytes = Uint8Array.from(audioBuffer);
  return new Blob([exactBytes], { type: normalizeAudioMimeType(mimeType) });
}

async function deleteUploadedFile(ai, uploadedFile) {
  const name = String(uploadedFile?.name || "").trim();
  if (!name || !ai?.files?.delete) return;
  try {
    await ai.files.delete({ name });
  } catch (err) {
    // Cleanup is best-effort. Google also expires Files API uploads after 48h,
    // so a cleanup failure must never turn a successful transcription into a
    // failed customer voice note.
    console.warn("Could not delete Gemini transcription upload:", err?.message || err);
  }
}

async function runTranscription(
  audioBuffer,
  mimeType,
  {
    env = process.env,
    createClient = (apiKey) => new GoogleGenAI({ apiKey }),
    createInteraction = createGeminiInteraction,
    runWithKeys = runWithGeminiKeys,
    prepareAudio = prepareAudioForTranscription,
    inlineAudioMaxBytes = DEFAULT_INLINE_AUDIO_MAX_BYTES,
  } = {}
) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return null;

  const model = getTranscriptionModel(env);

  try {
    // Normalize once before entering the provider key loop. Local media
    // conversion has nothing to do with API-key health and should never be
    // repeated for every configured Gemini credential.
    const preparedAudio = await prepareAudio(audioBuffer, mimeType);

    const transcript = await runWithKeys(
      async (apiKey) => {
        const ai = createClient(apiKey);
        let uploadedFile = null;
        try {
          let interactionAudioInput;

          // Inline ordinary voice notes directly in the Interactions request.
          // This removes the asynchronous Files API PROCESSING/FAILED step that
          // can intermittently reject an otherwise valid short voice message.
          if (preparedAudio.buffer.length <= Math.max(0, inlineAudioMaxBytes)) {
            interactionAudioInput = buildInlineInteractionAudioInput(
              preparedAudio.buffer,
              preparedAudio.mimeType
            );
          } else {
            // Keep Files API support for unusually large audio. Build the Blob
            // from an exact byte copy so pooled Node Buffer backing memory can
            // never corrupt the multipart upload.
            uploadedFile = await ai.files.upload({
              file: createExactUploadBlob(preparedAudio.buffer, preparedAudio.mimeType),
              config: { mimeType: preparedAudio.mimeType },
            });

            const readyFile = await waitForUploadedFileActive(ai, uploadedFile);
            interactionAudioInput = buildInteractionAudioInput(
              readyFile,
              preparedAudio.mimeType
            );
          }

          // Google's current Gemini 3.5 Transcribe guide uses the Interactions
          // API. It exposes a plain output_text convenience property and avoids
          // the legacy GenerateContent response.text/audioTranscription-part
          // mismatch that caused production transcripts to be dropped.
          const interaction = await createInteraction(
            ai,
            {
              model,
              input: [interactionAudioInput],
            },
            { purpose: "voice_transcription" }
          );

          return typeof interaction?.output_text === "string"
            ? interaction.output_text.trim()
            : "";
        } finally {
          await deleteUploadedFile(ai, uploadedFile);
        }
      },
      { retryCount: 1 }
    );

    if (!transcript || transcript === "[UNINTELLIGIBLE]") return null;
    return transcript;
  } catch (err) {
    console.error("Transcription failed:", err?.message || err);
    return null;
  }
}

/**
 * Convert an inbound customer voice note to text for the AI conversation.
 * Gemini 3.5 Transcribe automatically detects language and code switching.
 */
async function transcribeAudio(audioBuffer, mimeType) {
  return runTranscription(audioBuffer, mimeType);
}

/**
 * Convert an outbound staff voice recording to text for conversation context.
 * Uses the same verbatim speech-to-text path as inbound customer voice notes.
 */
async function transcribeStaffAudio(audioBuffer, mimeType) {
  return runTranscription(audioBuffer, mimeType);
}

module.exports = {
  DEFAULT_FILE_PROCESSING_POLL_INTERVAL_MS,
  DEFAULT_FILE_PROCESSING_TIMEOUT_MS,
  DEFAULT_INLINE_AUDIO_MAX_BYTES,
  DEFAULT_TRANSCRIPTION_MODEL,
  LOSSY_WHATSAPP_MIME_TYPES,
  buildInlineInteractionAudioInput,
  buildInteractionAudioInput,
  createExactUploadBlob,
  deleteUploadedFile,
  getTranscriptionModel,
  normalizeAudioMimeType,
  normalizeFileState,
  prepareAudioForTranscription,
  runTranscription,
  transcribeAudio,
  transcribeStaffAudio,
  waitForUploadedFileActive,
};
