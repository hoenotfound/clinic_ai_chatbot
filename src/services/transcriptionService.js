const { GoogleGenAI } = require("@google/genai");

// Transcription always goes through Gemini, regardless of AI_PROVIDER — Gemini
// Flash accepts audio natively and handles Malaysian multilingual speech
// (English / Bahasa Malaysia / Chinese, including mid-sentence code-switching,
// i.e. "Manglish") well. This means GEMINI_API_KEY must be set even when
// AI_PROVIDER=claude, since Claude's API doesn't accept audio input.
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

const TRANSCRIBE_PROMPT = `Transcribe this voice message exactly as spoken.

The speaker is a patient messaging a Malaysian aesthetics clinic. They may speak
English, Bahasa Malaysia, Mandarin/Cantonese, or switch between languages
mid-sentence (common in Malaysia, sometimes called "Manglish") — this is normal,
keep it as-is rather than translating or normalizing to one language.

Rules:
- Write Chinese speech in Chinese characters, not pinyin.
- Do not translate anything — output the same language(s) the speaker used.
- Do not add commentary, labels, or punctuation guesses beyond natural sentence breaks.
- If the audio is silent, just noise, or unintelligible, respond with exactly: [UNINTELLIGIBLE]
- Output only the transcript text, nothing else.`;

/**
 * @param {Buffer} audioBuffer - raw audio bytes downloaded from WhatsApp
 * @param {string} mimeType - e.g. "audio/ogg; codecs=opus" (WhatsApp voice notes)
 * @returns {Promise<string|null>} transcribed text, or null if transcription failed/unintelligible
 */
async function transcribeAudio(audioBuffer, mimeType) {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: TRANSCRIBE_PROMPT },
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

    const transcript = response.text?.trim();
    if (!transcript || transcript === "[UNINTELLIGIBLE]") return null;
    return transcript;
  } catch (err) {
    console.error("Transcription failed:", err);
    return null;
  }
}

module.exports = { transcribeAudio };
