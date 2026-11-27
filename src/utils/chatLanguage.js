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

// An English/Malay question may contain a Chinese treatment name. The name
// is not evidence that the customer's sentence is in Chinese.
const ENGLISH_SENTENCE_START = /^(?:(?:hi|hello|hey)[,!\s]+)?(?:how|what|when|where|why|which|can|could|would|will|is|are|do|does|did|may|should|please|i|i'm|i'd|we|we'd)\b/iu;
const CHINESE_CONVERSATION_MARKERS = /(?:我|你|您|请|請|问|問|想|吗|嗎|呢|这个|這個|那些|這些|多少|怎么|怎麼|哪里|哪裡|可以|怎样|怎樣|已经|已經|明天|现在|現在|谢谢|謝謝)/u;
const CHINESE_WITH_ENGLISH_ADMIN_TERM = /\b(?:price|pricing|prices|package|packages|promo|cost|trial)\b/iu;
// English sentence markers alongside a Chinese treatment name. Avoid treating
// a lone sales label such as "price?" as an English language switch.
const ENGLISH_MIXED_SENTENCE = /\b(?:interested\s+in|looking\s+for|available\s+(?:today|tomorrow|now|this|next)|(?:today|tomorrow)\s+available|book\s+(?:for|on)|want\s+to|need\s+to|i\s+(?:am|want|need)|how\s+much|what\s+is|is\s+there|can\s+i|do\s+you)\b/iu;
const MALAY_MIXED_SENTENCE = /\b(?:saya\s+(?:nak|mahu|ingin)|nak\s+tahu|boleh\s+(?:tahu|book|buat|cuba)|berapa\s+harga|ada\s+(?:tak|ke))\b/iu;

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
  const text = String(input || "").normalize("NFKC").trim()
    .replace(/[\s.!！。?？,，\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]+$/gu, "").trim();
  if (!text) return null;
  const withoutGreeting = text.replace(/^(?:hi|hello|hey|hai|你好|您好|嗨|salam)[!！,.，。\s]+/iu, "").trim();
  const single = (withoutGreeting || text).toLowerCase();
  if (/^(?:english|english pls|english please|in english(?: please| pls)?|please in english|speak english|reply in english|please (?:reply|speak) in english|can (?:you|u) (?:reply|speak) in english)$/iu.test(single)) return "en";
  if (/^(?:bm|bahasa|bahasa malaysia|bahasa melayu|malay|in malay|in bahasa|speak malay|reply in malay|please (?:reply|speak) in (?:malay|bahasa malaysia))$/iu.test(single)) return "ms";
  if (/^(?:中文|华语|華語|国语|國語|普通话|普通話|讲中文|講中文|用中文|请用中文|請用中文|中文回复|中文回覆|mandarin|chinese|in chinese|speak chinese|reply in chinese)$/iu.test(single)) return "zh";
  // A language selection followed by a comma and a service question is also
  // an explicit preference, but not a greeting-only enquiry.
  if (/^english(?: please| pls)?[,，:]\s*\S/iu.test(single)) return "en";
  if (/^(?:bm|bahasa malaysia|bahasa melayu|malay)(?: please)?[,，:]\s*\S/iu.test(single)) return "ms";
  if (/^(?:中文|华语|華語|mandarin|chinese)(?:回复|回覆| please)?[,，:]\s*\S/iu.test(single)) return "zh";
  // A clear request can accompany a service question, but general mentions of
  // a language (e.g. "English version of the price list") aren't commands.
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in english\b/iu.test(single)) return "en";
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in (?:malay|bahasa malaysia|bahasa melayu)\b/iu.test(single)) return "ms";
  if (/^(?:please |can (?:you|u) |could (?:you|u) )?(?:reply|speak|respond|answer)(?: to me)? in (?:chinese|mandarin)\b/iu.test(single)) return "zh";
  // Information requests are not language-only acknowledgements. Recognize
  // a language target plus an information/translation action, including common
  // Malaysian shorthand, without interpreting an arbitrary mention as a switch.
  const target = "(english|malay|bahasa(?: malaysia| melayu)?|bm|chinese|mandarin)";
  const locale = value => /^(?:english)$/iu.test(value) ? "en"
    : /^(?:chinese|mandarin)$/iu.test(value) ? "zh" : "ms";
  const polite = "(?:please|pls|plz|tq|thanks|thank you|tolong)";
  const info = "(?:info(?:rmation)?|details?|explanation|version|translation|penerangan|maklumat)";
  const normalized = single.replace(/\s+/gu, " ");
  const directInfo = normalized.match(new RegExp("^(?:" + polite + " )?" + target + " " + info + "(?: (?:for|about|on|regarding|of) [^.!?]{1,100}?)?(?:[, ]+" + polite + ")?$", "iu"));
  if (directInfo && !/^(?:english|malay|bahasa(?: malaysia| melayu)?|bm|chinese|mandarin) version of\b/iu.test(normalized)) return locale(directInfo[1]);
  const explainIn = normalized.match(new RegExp("^(?:(?:can|could|would) (?:you |u )?|please |pls |plz |(?:i |we )(?:want|need) (?:to )?)?(?:explain|translate|repeat|send|share|provide|give|tell|describe|write|say|info(?:rmation)?|details?|explanation)\\b[^.!?\\n]{0,160}?\\bin " + target + "(?:[, ]+" + polite + ")?$", "iu"));
  if (explainIn) return locale(explainIn[1]);
  const infoIn = normalized.match(new RegExp("^(?:(?:the|more|some) )?" + info + "(?: (?:for|about|on|of) [^.!?]{1,100}?)? (?:in|dalam) " + target + "(?:[, ]+" + polite + ")?$", "iu"));
  if (infoIn) return locale(infoIn[1]);
  const malayInfo = normalized.match(new RegExp("^(?:(?:boleh|tolong|sila|nak|mahu) )?(?:terangkan|jelaskan|hantar|beri|berikan|kongsi|maklumat|penerangan|info)\\b[^.!?\\n]{0,160}?\\bdalam " + target + "(?:[, ]+" + polite + ")?$", "iu"));
  if (malayInfo) return locale(malayInfo[1]);
  const chineseRequest = normalized.match(/^(?:请|請|麻烦|麻煩|可以|能不能|能|想要|我想要|我想看)?(?:用|发|發|给|給)?(?:我)?(英文|英语|英語|中文|华语|華語|马来文|馬來文|马来语|馬來語)(?:的)?(?:介绍|介紹|解释|解釋|说明|說明|资料|資料|版本|翻译|翻譯|发给我|發給我)(?:[^。！？!?]{0,60})$/u);
  if (chineseRequest) return /^(?:英文|英语|英語)$/u.test(chineseRequest[1]) ? "en"
    : /^(?:中文|华语|華語)$/u.test(chineseRequest[1]) ? "zh" : "ms";
  if (/^(?:请|請|麻烦|麻煩|可以)?(?:用)?(?:英文|英语|英語)(?:介绍|介紹|解释|解釋|说明|說明|资料|資料|版本|翻译|翻譯|发给我|發給我)(?:一下|给我|給我|吗|嗎|谢谢|謝謝|好吗|好嗎)*$/u.test(normalized)) return "en";
  if (/^(?:请|請|麻烦|麻煩|可以)?(?:用)?(?:中文|华语|華語)(?:介绍|介紹|解释|解釋|说明|說明|资料|資料|版本|翻译|翻譯|发给我|發給我)(?:一下|给我|給我|吗|嗎|谢谢|謝謝|好吗|好嗎)*$/u.test(normalized)) return "zh";
  if (/^(?:请|請|麻烦|麻煩|可以)?(?:用)?(?:马来文|馬來文|马来语|馬來語)(?:介绍|介紹|解释|解釋|说明|說明|资料|資料|版本|翻译|翻譯|发给我|發給我)(?:一下|给我|給我|吗|嗎|谢谢|謝謝|好吗|好嗎)*$/u.test(normalized)) return "ms";
  return null;
}

// A language mention is evidence for asking the model to interpret intent,
// NOT a language switch by itself. Only one unambiguous target is eligible.
function languageRequestCandidate(input) {
  const text=String(input||"").normalize("NFKC").trim();
  if(!text || text.length>300 || detectExplicitLanguagePreference(text)) return null;
  const candidates=[
    ["en",/\benglish\b|英文|英语|英語/iu],
    ["ms",/\b(?:malay|bahasa(?: malaysia| melayu)?|bm)\b|马来文|馬來文|马来语|馬來語/iu],
    ["zh",/\b(?:chinese|mandarin)\b|中文|华语|華語|普通话|普通話/iu],
  ].filter(([,pattern])=>pattern.test(text));
  return candidates.length===1?candidates[0][0]:null;
}
function verifiedModelLanguageRequest(text, candidate, details) {
  if(!candidate || candidate!==languageRequestCandidate(text))return null;
  return details?.requestedReplyLanguage===candidate &&
    details?.languageRequestEvidence===String(text||"").trim()?candidate:null;
}
function isGreetingOrLanguageOnly(input) {
  const text = String(input || "").trim();
  if (!text) return false;
  const withoutGreeting = text
    .replace(/^(?:(?:hi|hello|hey|hai|你好|您好|嗨|哈喽|哈囉|salam|assalamualaikum)[!！,.，。\s]*)/iu, "")
    .trim();
  const candidate = (withoutGreeting || text).replace(/[!！.。?？]+$/u, "").trim();
  if (detectExplicitLanguagePreference(candidate)) {
    return /^(?:english(?: (?:pls|please))?|in english(?: please| pls)?|please in english|speak english|reply in english|please (?:reply|speak) in english|can (?:you|u) (?:reply|speak) in english|bm|bahasa(?: malaysia| melayu)?|malay|in malay|in bahasa|speak malay|reply in malay|please (?:reply|speak) in (?:malay|bahasa malaysia)|中文|华语|華語|国语|國語|普通话|普通話|讲中文|講中文|用中文|请用中文|請用中文|中文回复|中文回覆|mandarin|chinese|in chinese|speak chinese|reply in chinese)$/iu.test(candidate);
  }
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
  const chinese = CHINESE_CHARACTERS.test(text);
  const tokens = text.toLowerCase().match(/[a-z]+/g) || [];
  if (!tokens.length) return chinese ? "zh" : null;

  const malayScore = tokens.reduce(
    (score, token) => score + (MALAY_WORDS.has(token) ? 1 : 0),
    0
  );
  const englishScore = tokens.reduce(
    (score, token) => score + (ENGLISH_WORDS.has(token) ? 1 : 0),
    0
  );

  if (chinese) {
    const chineseCount = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) || []).length;
    // Keep actual Chinese sentences in Chinese, even when they contain common
    // English commercial words. Small Chinese treatment names can occur in
    // otherwise English or Malay sentences and must not force Chinese.
    if (chineseCount <= 12 && !CHINESE_CONVERSATION_MARKERS.test(text)) {
      if (MALAY_MIXED_SENTENCE.test(text) ||
          (malayScore >= 2 && malayScore > englishScore)) return "ms";
      if (ENGLISH_MIXED_SENTENCE.test(text) ||
          englishScore >= 2 ||
          (englishScore >= 1 && ENGLISH_SENTENCE_START.test(text))) {
        return "en";
      }
      // A standalone treatment name plus "price?" is ambiguous: inherit the
      // customer's earlier meaningful language, not the treatment's script.
      if (CHINESE_WITH_ENGLISH_ADMIN_TERM.test(text)) return null;
    }
    return "zh";
  }

  if (malayScore > 0 && malayScore >= englishScore) return "ms";
  if (englishScore > 0) return "en";

  // Do not guess from Latin characters alone. An unrecognized Malay phrase
  // can look identical to English at this level. Leaving it ambiguous lets
  // earlier customer messages or the matching outgoing reply decide, with
  // English used only as the final conversation fallback.
  return null;
}

// One-word administrative shorthand often follows a conversation already held
// in Chinese or Malay. It asks a question, not for a switch to English.
const ENGLISH_ADMIN_SHORTHAND =
  /^(?:price|prices|pricing|trial\s+price|first\s+trial|trial|promo\s+price|package\s+price|location|address|cost|fee|fees|hours|opening hours|packages?|promo)[\s?.!！。？]*$/iu;

// Shared selection for customer replies, promotional media and follow-up
// locale. Earlier customer messages decide when the latest message is only a
// service name or a short sales term. The old Chinese fallback for ambiguous
// Chinese-name shorthand remains when no prior language evidence exists.
function detectConversationLanguage(recentMessages, fallback = "en", savedPreference = null) {
  // Explicit preferences survive bounded history. A newer explicit request wins.
  if (["en", "ms", "zh"].includes(savedPreference)) {
    for (const message of recentMessages || []) {
      const explicit = detectExplicitLanguagePreference(message);
      if (explicit) return explicit;
    }
    return savedPreference;
  }
  let ambiguousChinese = false;
  for (const message of recentMessages || []) {
    const text = String(message || "").trim();
    const explicit = detectExplicitLanguagePreference(text);
    if (explicit) return explicit;
    if (ENGLISH_ADMIN_SHORTHAND.test(text)) continue;
    const detected = detectMessageLanguage(text);
    if (detected) return detected;
    if (CHINESE_CHARACTERS.test(text)) ambiguousChinese = true;
  }
  return ambiguousChinese ? "zh" : fallback;
}

// Keep the named entry point for the live reply path, but share exactly the
// same customer-language rules with follow-up template selection.
function detectReplyConversationLanguage(recentMessages, fallback = "en", savedPreference = null) {
  return detectConversationLanguage(recentMessages, fallback, savedPreference);
}

module.exports = {
  languageRequestCandidate,
  verifiedModelLanguageRequest,
  detectMessageLanguage,
  detectConversationLanguage,
  detectReplyConversationLanguage,
  detectExplicitLanguagePreference,
  isGreetingOrLanguageOnly,
  shouldGenerateLocalizedIntro,
};
