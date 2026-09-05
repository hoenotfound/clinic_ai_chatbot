const { Blob } = require("node:buffer");
const { GoogleGenAI } = require("@google/genai");
const { generateGeminiContent } = require("./aiUsageService");
const { convertToMp3 } = require("./audioConvertService");
const { runWithGeminiKeys } = require("./geminiKeyPool");

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";
const DEFAULT_FILE_PROCESSING_TIMEOUT_MS = 10 * 1000;
const DEFAULT_FILE_PROCESSING_POLL_INTERVAL_MS = 250;
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

function createAudioNormalizationError(message) {
  const err = new Error(message);
  err.code = "AUDIO_NORMALIZATION_FAILED";
  // A local FFmpeg/media failure is not evidence that any Gemini key is bad.
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

  // WhatsApp voice notes are normally Ogg/Opus. Gemini 3.5 Transcribe lists
  // OGG/Opus as supported, but real Meta voice-note containers can still fail
  // asynchronous Files API processing. The app already uses this FFmpeg path
  // for reliable Inbox playback, so normalize those voice notes to a clean MP3
  // before upload instead of sending the provider the original container.
  const converted = await convertToMp3Fn(audioBuffer);
  if (!converted?.buffer || !Buffer.isBuffer(converted.buffer) || converted.buffer.length === 0) {
    throw createAudioNormalizationError(
      "Could not normalize the voice note into a transcription-safe audio file."
    );
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

function buildUploadedAudioPart(uploadedFile, fallbackMimeType) {
  const fileUri = String(uploadedFile?.uri || "").trim();
  if (!fileUri) {
    const err = new Error("Gemini Files API upload did not return a usable file URI.");
    err.code = "INVALID_AI_RESPONSE";
    throw err;
  }

  return {
    fileData: {
      fileUri,
      mimeType: normalizeAudioMimeType(uploadedFile?.mimeType || fallbackMimeType),
    },
  };
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
    generateContent = generateGeminiContent,
    runWithKeys = runWithGeminiKeys,
    prepareAudio = prepareAudioForTranscription,
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
          uploadedFile = await ai.files.upload({
            file: new Blob([preparedAudio.buffer], { type: preparedAudio.mimeType }),
            config: { mimeType: preparedAudio.mimeType },
          });

          const readyFile = await waitForUploadedFileActive(ai, uploadedFile);

          const response = await generateContent(
            ai,
            {
              model,
              contents: [buildUploadedAudioPart(readyFile, preparedAudio.mimeType)],
              config: {
                maxOutputTokens: 500,
                audioTranscriptionConfig: {
                  // Empty language hints enable automatic language detection
                  // and intra-sentence code switching (English/BM/Chinese).
                  languageCodes: [],
                  // Preserve exactly what the customer/staff member said.
                  mode: "VERBATIM",
                },
              },
            },
            { purpose: "voice_transcription" }
          );

          return response.text?.trim() || "";
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
  DEFAULT_TRANSCRIPTION_MODEL,
  LOSSY_WHATSAPP_MIME_TYPES,
  buildUploadedAudioPart,
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
