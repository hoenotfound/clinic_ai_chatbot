// A clinic service name alone is not a request for a diagnosis or medical
// clearance. Recover only exact, independently configured service phrases.
// Anything with symptoms, personal suitability, or unrecognized wording stays
// on the AI's ordinary review/handoff path.
const { checkKeywordTriggers } = require("./attentionTriggers");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer, hasCommercialReplyContent } = require("./initialOfferReplyGuard");

function key(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bareServiceName(text, services, aliases) {
  const original = String(text || "").normalize("NFKC").trim();
  if (!original || original.length > 90) return null;
  // Trim only conversational punctuation; never strip medical qualifiers
  // such as "after surgery" or "because of L4/L5".
  const phrase = original.replace(/^[\s.,!?。，！？～~]+|[\s.,!?。，！？～~]+$/gu, "").trim();
  if (!phrase || checkKeywordTriggers(original) || hasClinicalMediaRisk(original)) return null;

  const service = safeServiceFromCustomer(phrase, services, aliases);
  if (!service) return null;
  const normalized = key(phrase);
  const names = [service.name];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (key(alias?.officialService) !== key(service.name)) continue;
    names.push(...String(alias?.alias || "").split(/[,|;，、]+/u));
  }
  if (!names.some((name) => key(name) === normalized)) return null;
  return { service, phrase };
}

function recoverTcmServiceReviewReply({
  businessType, customerText, language, services, serviceAliases,
} = {}) {
  if (businessType !== "tcm_clinic") return null;
  const matched = bareServiceName(customerText, services, serviceAliases);
  if (!matched) return null;
  const { phrase, service } = matched;
  const locale = String(language || "").toLowerCase();
  let reply;
  if (locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(phrase))) {
    reply = `有的～我们有${service.name}相关的护理 😊 不过还是需要中医师先了解您的情况，再判断哪种方式适合。您想先安排1对1评估吗？`;
  } else if (locale.startsWith("ms")) {
    reply = `Ya, kami ada rawatan berkaitan ${phrase} 😊 Pengamal kami perlu menilai keadaan anda dahulu sebelum mencadangkan rawatan yang sesuai. Nak aturkan sesi penilaian 1-ke-1?`;
  } else {
    reply = `Yes, we offer care related to ${phrase} 😊 Our practitioner would first assess your concerns before advising which treatment, if any, is suitable. Would you like to arrange a 1-to-1 assessment?`;
  }
  // Configured service names can be edited by staff. Reject unsafe commercial
  // content instead of turning a model review into an unsolicited offer.
  return hasCommercialReplyContent(reply) ? null : reply;
}

module.exports = { bareServiceName, recoverTcmServiceReviewReply };
