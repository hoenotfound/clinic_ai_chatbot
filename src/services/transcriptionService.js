const { Blob } = require("node:buffer");
const { GoogleGenAI } = require("@google/genai");
const { generateGeminiContent } = require("./aiUsageService");
const { runWithGeminiKeys } = require("./geminiKeyPool");

const DEFAULT_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";

function getTranscriptionModel(env = process.env) {
  return String(env.GEMINI_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIPTION_MODEL).trim()
    || DEFAULT_TRANSCRIPTION_MODEL;
}

function normalizeAudioMimeType(mimeType) {
  return String(mimeType || "audio/ogg").split(";")[0].trim() || "audio/ogg";
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
  } = {}
) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return null;

  const model = getTranscriptionModel(env);
  const normalizedMimeType = normalizeAudioMimeType(mimeType);

  try {
    const transcript = await runWithKeys(
      async (apiKey) => {
        const ai = createClient(apiKey);
        let uploadedFile = null;
        try {
          // Gemini 3.5 Transcribe is a dedicated speech-to-text model. Use the
          // Files API upload, then pass an explicit fileData part so this works
          // with the repository's pinned @google/genai 2.17.1 transformer as
          // well as newer SDK releases.
          uploadedFile = await ai.files.upload({
            file: new Blob([audioBuffer], { type: normalizedMimeType }),
            config: { mimeType: normalizedMimeType },
          });

          const response = await generateContent(
            ai,
            {
              model,
              contents: [buildUploadedAudioPart(uploadedFile, normalizedMimeType)],
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
  DEFAULT_TRANSCRIPTION_MODEL,
  buildUploadedAudioPart,
  deleteUploadedFile,
  getTranscriptionModel,
  normalizeAudioMimeType,
  runTranscription,
  transcribeAudio,
  transcribeStaffAudio,
};
