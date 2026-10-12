// Narrow TCM-only review recovery. A bare verified service name permits general
// information, but medical context never becomes permission to recommend care.
const {
  checkKeywordTriggers,
  isUrgentSafetyMessage,
} = require("./attentionTriggers");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const {
  safeServiceFromCustomer,
  hasCommercialReplyContent,
} = require("./initialOfferReplyGuard");

function key(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function bareServiceName(text, services, aliases) {
  const original = String(text || "").normalize("NFKC").trim();
  if (!original || original.length > 90) return null;
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

const SPINAL_CONCERN = /\b(?:l[1-5]\s*[\/+-]\s*[ls]?[1-5]|(?:lumbar|lumber)\s+spine|slipped\s+disc|herniated\s+disc|disc\s+(?:bulge|protrusion)|scoliosis|sciatica|spinal\s+stenosis)\b|(?:腰椎|脊椎|椎间盘|椎間盤|脊柱側彎|脊柱侧弯)/iu;
const STANDALONE_SPINE = /^(?:(?:lumbar|lumber)\s+spine\s+(?:(?:l)?[1-5]\s*[+\/-]\s*[ls]?[1-5]|[1-5]\s+(?:and|&)\s+[1-5])|l[1-5]\s*[\/-]\s*[ls]?[1-5])$/iu;
const ASSESSMENT = /(?:assessment|评估|評估|penilaian)/iu;
const ASSESSMENT_INVITE = /(?:arrange|book|schedule|would you like|want to come|come in for|安排|预约|預約|約個|约个|nak aturkan|nak buat|buat temujanji)/iu;

function isStandaloneSpinalConcern(text) {
  const value = String(text || "").normalize("NFKC").trim()
    .replace(/[.!?。！？]+$/u, "").trim();
  return value.length <= 75 && STANDALONE_SPINE.test(value);
}

function recentConversationContext(history) {
  // Model history is oldest-to-newest and includes the current user message.
  // Inspect a bounded number of preceding turns; never use customer text as
  // instruction, only as a signal that professional assessment is required.
  const entries = history.slice(-16, -1);
  const priorCustomers = entries.filter((m) => m?.role === "user")
    .slice(-8).map((m) => String(m.content || ""));
  const priorAssistants = entries.filter((m) => m?.role === "assistant")
    .slice(-5).map((m) => String(m.content || ""));
  return {
    medicalContext: priorCustomers.some((m) =>
      SPINAL_CONCERN.test(m) || hasClinicalMediaRisk(m)
    ),
    urgentContext: priorCustomers.some((m) => isUrgentSafetyMessage(m)),
    alreadyInvited: priorAssistants.some((m) =>
      ASSESSMENT.test(m) && ASSESSMENT_INVITE.test(m)
    ),
  };
}

function recoveryText({ phrase, service, language, medicalContext, alreadyInvited }) {
  const locale = String(language || "").toLowerCase();
  const chinese = locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(phrase));
  const malay = locale.startsWith("ms");
  const spine = !service;

  if (chinese) {
    const intro = spine
      ? "谢谢您分享腰椎方面的情况。这个需要中医师先了解和评估，才能判断适合哪种护理。"
      : medicalContext
        ? "有的～我们有" + service.name + "相关的护理 😊 结合您之前提到的身体情况，中医师需要先评估，才能判断是否适合。"
        : "有的～我们有" + service.name + "相关的护理 😊 中医师会先了解您的情况，再建议适合的方式。";
    return alreadyInvited ? intro : intro + " 您想先安排1对1的体态评估吗？";
  }
  if (malay) {
    const intro = spine
      ? "Terima kasih kerana berkongsi tentang tulang belakang anda. Pengamal kami perlu menilai keadaan anda sebelum mencadangkan sebarang rawatan."
      : medicalContext
        ? "Kami ada rawatan berkaitan " + phrase + " 😊 Dengan keadaan kesihatan yang anda sebut tadi, pengamal kami perlu buat penilaian sebelum mencadangkan rawatan."
        : "Kami ada rawatan berkaitan " + phrase + " 😊 Pengamal kami akan menilai keadaan anda dahulu sebelum mencadangkan rawatan yang sesuai.";
    return alreadyInvited ? intro : intro + " Nak aturkan sesi penilaian 1-ke-1?";
  }
  const intro = spine
    ? "Thanks for sharing about your lower back. Our practitioner would need to assess your condition before advising any treatment."
    : medicalContext
      ? "We provide services related to " + phrase + " 😊 With the health concern you mentioned earlier, our practitioner needs to assess what is suitable before recommending treatment."
      : "We provide services related to " + phrase + " 😊 Our practitioner would first assess your concerns before advising which treatment, if any, is suitable.";
  return alreadyInvited ? intro : intro + " Would you like to arrange a 1-to-1 assessment?";
}

function planTcmReviewReply({
  businessType, customerText, language, services, serviceAliases,
  conversationHistory, pendingClinicalReview = false,
} = {}) {
  if (businessType !== "tcm_clinic" || !Array.isArray(conversationHistory)) return null;
  const matched = bareServiceName(customerText, services, serviceAliases);
  const spine = isStandaloneSpinalConcern(customerText);
  if (!matched && !spine) return null;
  if (pendingClinicalReview !== true && pendingClinicalReview !== false) return null;

  const context = recentConversationContext(conversationHistory);
  // Do not continue selling on the back of recent emergency symptoms.
  if (context.urgentContext) return { reply: null, preserveReview: true };
  const medicalContext = spine || context.medicalContext || pendingClinicalReview;
  const reply = recoveryText({
    phrase: matched?.phrase || String(customerText || ""),
    service: matched?.service || null,
    language,
    medicalContext,
    alreadyInvited: context.alreadyInvited,
  });
  // All outputs are static, non-diagnostic and unpriced. A staff-edited service
  // name must not introduce unauthorized promotions or prices.
  if (hasCommercialReplyContent(reply)) return null;
  return { reply, preserveReview: Boolean(medicalContext) };
}

// Compatibility helper for simple isolated service reviews.
function recoverTcmServiceReviewReply(options = {}) {
  const text = String(options.customerText || "");
  const plan = planTcmReviewReply({
    ...options,
    conversationHistory: [{ role: "user", content: text }],
    pendingClinicalReview: false,
  });
  return plan && !plan.preserveReview ? plan.reply : null;
}

module.exports = {
  bareServiceName,
  isStandaloneSpinalConcern,
  planTcmReviewReply,
  recoverTcmServiceReviewReply,
};
