const CHINESE_CHARACTERS = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

// Words that are useful signals in short Malaysian WhatsApp messages. Common
// shared words such as "clinic" and "appointment" are deliberately omitted.
// Casual particles such as "ya" are intentionally language-neutral because
// they are common in both Malay and Malaysian English conversations.
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

// An explicit language request takes priority over the script used to name a
// treatment (for example "English please, 骨盆调理").
function detectExplicitLanguagePreference(input) {
  const text = String(input || "").trim().replace(/[.!！。?？]+$/u, "").trim();
  if (!text) return null;
  const single = text.toLowerCase();
  if (/^(?:english|english pls|english please|in english|speak english|reply in english|please (?:reply|speak) in english|can (?:you|u) (?:reply|speak) in english)$/iu.test(single)) return "en";
  if (/^(?:bm|bahasa|bahasa malaysia|bahasa melayu|malay|in malay|in bahasa|speak malay|reply in malay|please (?:reply|speak) in (?:malay|bahasa malaysia))$/iu.test(single)) return "ms";
  if (/^(?:中文|华语|華語|国语|國語|普通话|普通話|讲中文|講中文|用中文|请用中文|請用中文|中文回复|中文回覆|mandarin|chinese|in chinese|speak chinese|reply in chinese)$/iu.test(single)) return "zh";
  // A clear request can accompany a service question, but general mentions of
  // a language (e.g. "English version of the price list") aren't commands.
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in english\b/iu.test(single)) return "en";
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in (?:malay|bahasa malaysia|bahasa melayu)\b/iu.test(single)) return "ms";
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in (?:chinese|mandarin)\b/iu.test(single)) return "zh";
  return null;
}

function isGreetingOrLanguageOnly(input) {
  const text = String(input || "").trim();
  if (!text) return false;
  const withoutGreeting = text
    .replace(/^(?:(?:hi|hello|hey|hai|你好|您好|嗨|哈喽|哈囉|salam|assalamualaikum)[!！,.，。\s]*)/iu, "")
    .trim();
  if (detectExplicitLanguagePreference(withoutGreeting || text)) return true;
  return /^(?:hi|hello|hey|hai|你好|您好|嗨|哈喽|哈囉|salam|assalamualaikum|👋|👍)[!！,.，。\s👋😊🙂]*$/iu.test(text);
}

function shouldGenerateLocalizedIntro(customerText, configuredIntro) {
  const requested = detectMessageLanguage(customerText);
  if (!requested || !String(configuredIntro || "").trim()) return false;
  const intro = String(configuredIntro);
  const introLanguage = detectMessageLanguage(intro) ||
    (/[a-z]{2,}/iu.test(intro) ? "en" : null);
  return introLanguage !== null && introLanguage !== requested;
}

function detectMessageLanguage(input) {
  const text = String(input || "").trim();
  if (!text) return null;
  const preferred = detectExplicitLanguagePreference(text);
  if (preferred) return preferred;
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

module.exports = {
  detectMessageLanguage,
  detectConversationLanguage,
  detectExplicitLanguagePreference,
  isGreetingOrLanguageOnly,
  shouldGenerateLocalizedIntro,
};
