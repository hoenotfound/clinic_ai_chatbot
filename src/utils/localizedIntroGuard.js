// A language model can be asked to preserve a clinic's saved introduction,
// but its translated prose cannot be assumed to preserve exact offer amounts,
// links, contact details or service codes. When any checkable literal is lost,
// append the original clinic introduction rather than silently dropping facts.
const PROTECTED_FACT_PATTERNS = [
  /https?:\/\/[^\s<>]+/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:RM|MYR)\s*[\d,]+(?:\.\d+)?\b/giu,
  /(?:\+?60|0)[\d\s()-]{7,18}\d/gu,
  /\b\d+(?:\.\d+)?\s*%/gu,
  /\b(?:3D|9D)\b/giu,
];

function comparableLiteral(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s()\-\u2013\u2014]/gu, "");
}

function missingProtectedIntroFacts(configuredIntro, generatedReply) {
  const intro = String(configuredIntro || "");
  const reply = comparableLiteral(generatedReply);
  const literals = new Set();
  for (const pattern of PROTECTED_FACT_PATTERNS) {
    for (const match of intro.matchAll(pattern)) {
      const value = match[0].replace(/[.,;:!？。]+$/u, "");
      if (value) literals.add(value);
    }
  }
  return [...literals].filter((value) => !reply.includes(comparableLiteral(value)));
}

function preserveOriginalIntroFacts(configuredIntro, generatedReply) {
  const original = String(configuredIntro || "").trim();
  const reply = String(generatedReply || "").trim();
  const missing = missingProtectedIntroFacts(original, reply);
  if (!original || missing.length === 0 || reply.includes(original)) {
    return { reply, usedOriginalFallback: false, missingCount: 0 };
  }

  // Fail-safe for unverifiable AI translation: facts remain accessible without
  // inventing a translated price, voucher condition, contact or treatment.
  return {
    reply: [reply, "Original clinic introduction:", original].join("\n\n"),
    usedOriginalFallback: true,
    missingCount: missing.length,
  };
}

module.exports = { missingProtectedIntroFacts, preserveOriginalIntroFacts };
