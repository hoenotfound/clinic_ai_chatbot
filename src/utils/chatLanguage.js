const CHINESE_CHARACTERS = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

// Words that are useful signals in short Malaysian WhatsApp messages. Common
// shared words such as "clinic" and "appointment" are deliberately omitted.
const MALAY_WORDS = new Set([
  "ada",
  "anda",
  "awak",
  "bagaimana",
  "belum",
  "berapa",
  "bila",
  "boleh",
  "dekat",
  "harga",
  "ini",
  "jerawat",
  "kulit",
  "mahu",
  "malam",
  "macam",
  "mana",
  "muka",
  "nak",
  "pagi",
  "petang",
  "rawatan",
  "sakit",
  "saya",
  "selamat",
  "tak",
  "tanya",
  "terima",
  "tidak",
  "tolong",
  "untuk",
  "yang",
]);

const ENGLISH_WORDS = new Set([
  "are",
  "available",
  "can",
  "cost",
  "do",
  "help",
  "how",
  "interested",
  "is",
  "much",
  "need",
  "price",
  "treatment",
  "want",
  "what",
  "when",
  "where",
  "which",
  "you",
]);

function detectMessageLanguage(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  if (CHINESE_CHARACTERS.test(text)) return "zh";

  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  if (!tokens.length) return null;

  const malayScore = tokens.reduce(
    (score, token) => score + (MALAY_WORDS.has(token) ? 1 : 0),
    0
  );
  const englishScore = tokens.reduce(
    (score, token) => score + (ENGLISH_WORDS.has(token) ? 1 : 0),
    0
  );

  if (malayScore > 0 && malayScore >= englishScore) return "ms";
  if (englishScore > 0) return "en";

  // A longer Latin-script sentence without Malay signals is most likely
  // English. Very short replies such as "ok" are intentionally ambiguous,
  // allowing an earlier meaningful customer message to decide the language.
  return tokens.length >= 3 ? "en" : null;
}

function detectConversationLanguage(recentMessages, fallback = "en") {
  for (const message of recentMessages || []) {
    const detected = detectMessageLanguage(message);
    if (detected) return detected;
  }
  return fallback;
}

module.exports = { detectMessageLanguage, detectConversationLanguage };
