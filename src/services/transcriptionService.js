const { GoogleGenAI } = require("@google/genai");
const { runWithGeminiKeys } = require("./geminiKeyPool");

// Transcription always goes through Gemini, regardless of AI_PROVIDER. Gemini
// Flash accepts audio natively and handles Malaysian multilingual speech
// (English / Bahasa Malaysia / Chinese, including mid-sentence code-switching)
// well. The shared Gemini key pool is used here so voice notes get the same
// quota failover and cooldown behavior as normal chatbot replies.
const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

const TRANSCRIBE_PROMPT = `Transcribe this voice message exactly as spoken.

The speaker is a patient messaging a Malaysian aesthetics clinic. They may speak
English, Bahasa Malaysia, Mandarin/Cantonese, or switch between languages
mid-sentence (common in Malaysia, sometimes called "Manglish") - this is normal,
keep it as-is rather than translating or normalizing to one language.

Rules:
- Write Chinese speech in Chinese characters, not pinyin.
- Do not translate anything - output the same language(s) the speaker used.
- Do not add commentary, labels, or punctuation guesses beyond natural sentence breaks.
- If the audio is silent, just noise, or unintelligible, respond with exactly: [UNINTELLIGIBLE]
- Output only the transcript text, nothing else.`;

const STAFF_TRANSCRIBE_PROMPT = `Transcribe this voice message exactly as spoken.

The speaker is a clinic staff member replying to a patient in Malaysia. They may
speak English, Bahasa Malaysia, Mandarin/Cantonese, or switch between languages
mid-sentence - this is normal, keep it as-is rather than translating or
normalizing to one language.

Rules:
- Write Chinese speech in Chinese characters, not pinyin.
- Do not translate anything - output the same language(s) the speaker used.
- Do not add commentary, labels, or punctuation guesses beyond natural sentence breaks.
- If the audio is silent, just noise, or unintelligible, respond with exactly: [UNINTELLIGIBLE]
- Output only the transcript text, nothing else.`;

/**
 * @param {Buffer} audioBuffer - raw audio bytes downloaded from WhatsApp
 * @param {string} mimeType - e.g. "audio/ogg; codecs=opus" (WhatsApp voice notes)
 * @returns {Promise<string|null>} transcribed text, or null if transcription failed/unintelligible
 */
async function runTranscription(audioBuffer, mimeType, prompt) {
  try {
    const transcript = await runWithGeminiKeys(
      async (apiKey) => {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inlineData: {
                    // Gemini wants the base mime type without codec params.
                    mimeType: mimeType.split(";")[0].trim() || "audio/ogg",
                    data: audioBuffer.toString("base64"),
                  },
                },
              ],
            },
          ],
          config: {
            maxOutputTokens: 500,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        return response.text?.trim() || "";
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

async function transcribeAudio(audioBuffer, mimeType) {
  return runTranscription(audioBuffer, mimeType, TRANSCRIBE_PROMPT);
}

async function transcribeStaffAudio(audioBuffer, mimeType) {
  return runTranscription(audioBuffer, mimeType, STAFF_TRANSCRIBE_PROMPT);
}

module.exports = { transcribeAudio, transcribeStaffAudio };
