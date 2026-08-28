const CHINESE_CHARACTERS = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

// Words that are useful signals in short Malaysian WhatsApp messages. Common
// shared words such as "clinic" and "appointment" are deliberately omitted.
const MALAY_WORDS = new Set([
  "ada",
  "adakah",
  "apa",
  "anda",
  "awak",
  "bagaimana",
  "belum",
  "berapa",
  "berkesan",
  "berminat",
  "bila",
  "boleh",
  "dekat",
  "dengan",
  "dah",
  "harga",
  "juga",
  "ini",
  "jerawat",
  "kulit",
  "kesan",
  "mahu",
  "malam",
  "macam",
  "mana",
  "masih",
  "muka",
  "nak",
  "pagi",
  "petang",
  "rawatan",
  "sesuai",
  "sesi",
  "sakit",
  "sampingan",
  "saya",
  "selamat",
  "tak",
  "tanya",
  "terima",
  "tidak",
  "tolong",
  "untuk",
  "ubat",
  "ya",
  "yang",
]);

const ENGLISH_WORDS = new Set([
  "are",
  "available",
  "can",
  "cost",
  "do",
  "good",
  "help",
  "how",
  "interested",
  "is",
  "much",
  "morning",
  "need",
  "offer",
  "price",
  "promo",
  "promotion",
  "location",
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

  // Do not guess from Latin characters alone. An unrecognized Malay phrase
  // can look identical to English at this level. Leaving it ambiguous lets
  // earlier customer messages or the matching outgoing reply decide, with
  // English used only as the final conversation fallback.
  return null;
}

function detectConversationLanguage(recentMessages, fallback = "en") {
  for (const message of recentMessages || []) {
    const detected = detectMessageLanguage(message);
    if (detected) return detected;
  }
  return fallback;
}

module.exports = { detectMessageLanguage, detectConversationLanguage };
