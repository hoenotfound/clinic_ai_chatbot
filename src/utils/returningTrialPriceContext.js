"use strict";

// Neutro Shadow pricing: verified customer treatment, not a CRM/model/ad guess.
// Reads a separate, bounded DB history without extending the AI prompt.
const { hasExplicitPriceRequest, isFirstTrialAmountQuestion } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const {
  pricingMessageText, isVerifiedStaffTurn, assistantIntroducesCompetingPaidService,
  isContinuedTreatmentPriceQuestion,
} = require("./priceFollowUpContext");

const MAX_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CURRENT_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_TURNS = 100;
const RESET = /(?:换个|換個|换话题|換話題|改聊|另外想|另外问|另外問|改做|想换|想換|其他|其它|别的|別的|全部|所有|不想|不要|不需要|退订|退訂|\b(?:instead|switch|different|another|other\s+treatments?|all\s+treatments?|stop|unsubscribe|opt\s*out|not\s+interested|don't\s+want)\b)/iu;
const NON_TREATMENT_FEE = /(?:免费|免費|评估|評估|assessment|consultation|deposit|订金|訂金|预约费|預約費|booking[\s-]*fee|admin(?:istration)?[\s-]*fee)/iu;
const FIRST_TRIAL = /(?:第一次|首次|初次)\s*(?:体验|體驗|护理|護理|疗程|療程|做|来|來)?|\b(?:first[\s-]*trial|trial[\s-]*(?:price|cost)|harga[\s-]*percubaan)\b/iu;
const PRICE_REQUEST = /(?:多少[钱錢]|[几幾]多[钱錢]|(?:价钱|價錢|价格|價格|价位|費用|费用|收费|收費)\s*(?:是|要|大概|多少|几多|幾多)?\s*[?？]|(?:想(?:问|問|知道|了解|看看)|请问|請問|可(?:以|否)|告诉|告訴|发给|發給|给我|給我|麻烦|麻煩).{0,32}(?:价格|價格|价钱|價錢|费用|費用|收费|收費)|\b(?:how\s+much|price|pricing|cost|fee|harga|berapa\s+(?:harga|bayar|satu\s+sesi))\b)/iu;
const OPINION_ONLY = /(?:[价價](?:格|钱|錢|位).{0,18}(?:太贵|太貴|好贵|好貴|很贵|很貴|偏高|超出预算|超出預算)|(?:预算|預算).{0,25}(?:是|只有|不到|RM)|\b(?:too\s+expensive|over\s+budget|mahal\s+sangat)\b)/iu;
const DIFFERENT_UNCONFIGURED_SUBJECT = /(?:想了解|想问|想問|想做|做其他|请问|請問|换成|換成).{0,32}(?:按摩|肩颈|肩頸|筋膜|皮肤|皮膚|美容|面部|洗脸|洗臉|\b(?:massage|facial|skin\s+treatment|full\s*body)\b)/iu;
const FREE_INTRO = /(?:免费|免費|complimentary|percuma|free).{0,50}(?:1\s*[对對]\s*1|体态评估|體態評估|assessment).{0,25}(?:体验|體驗|experience|sesi)?/iu;
const INTRO_ASSESSMENT = /(?:先|首先|会先|會先|可以先).{0,44}(?:1\s*[对對]\s*1|体态评估|體態評估|assessment).{0,25}(?:体验|體驗|experience|sesi)/iu;

function isSpecificCurrentPriceRequest(text) {
  return Boolean(text) && text.length <= 120 &&
    hasExplicitPriceRequest(text) &&
    (PRICE_REQUEST.test(text) || isContinuedTreatmentPriceQuestion(text) ||
      isFirstTrialAmountQuestion(text)) &&
    !RESET.test(text) && !NON_TREATMENT_FEE.test(text) &&
    !OPINION_ONLY.test(text) && !DIFFERENT_UNCONFIGURED_SUBJECT.test(text) &&
    !hasClinicalMediaRisk(text);
}

function isSafeFreeAssessmentExplanation(turn, chosen, candidates, complimentaryEnabled) {
  const value = pricingMessageText(turn);
  if (!complimentaryEnabled ||
      !(FREE_INTRO.test(value) || INTRO_ASSESSMENT.test(value)) ||
      /\b(?:RM|MYR)\s*[1-9]\d+/iu.test(value)) return false;
  const names = [...new Set(findServicesInText(value, candidates))];
  return names.length === 1 && names[0] === "1对1体态评估" &&
    chosen !== "1对1体态评估";
}

function resolveReturningTreatmentPriceService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  complimentaryAssessmentExperienceEnabled = false, now = Date.now(),
} = {}) {
  const current = String(customerText || "").normalize("NFKC").trim();
  if (!Number.isFinite(now) || !isSpecificCurrentPriceRequest(current) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  // Current explicit new-treatment questions use existing pricing paths.
  if (findServicesInText(current, candidates).length) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(turn => turn?.role === "user" || turn?.role === "assistant");
  if (turns.length < 3 || turns.length > MAX_HISTORY_TURNS ||
      turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).normalize("NFKC").trim() !== current) return null;

  const earliest = now - MAX_CONTEXT_AGE_MS;
  let previousAt = -Infinity;
  for (const turn of turns) {
    const at = turn.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at < earliest || at > now + 60_000 ||
        at < previousAt) return null;
    previousAt = at;
  }
  if (now - turns.at(-1).pricingCreatedAtMs > MAX_CURRENT_MESSAGE_AGE_MS)
    return null;

  // Search backwards for the latest independently named customer treatment,
  // rather than relying on the first customer message or an AI guess.
  let selectedIndex = -1, selected = null;
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "user") continue;
    const value = pricingMessageText(turn).trim();
    if (!value || RESET.test(value) || DIFFERENT_UNCONFIGURED_SUBJECT.test(value) ||
        hasClinicalMediaRisk(value)) return null;
    const names = [...new Set(findServicesInText(value, candidates))];
    if (names.length > 1) return null;
    if (!names.length) {
      if (NON_TREATMENT_FEE.test(value) && hasExplicitPriceRequest(value))
        return null;
      continue;
    }
    const exact = safeServiceFromCustomer(value, services, serviceAliases);
    if (!exact || exact.name !== names[0] || exact.name === "1对1体态评估")
      return null;
    selectedIndex = i;
    selected = exact;
    break;
  }
  if (!selected) return null;

  // Staff handoffs, unresolved changes, competing services or altered context
  // since this selection stop automatic pricing.
  const remaining = turns.slice(selectedIndex + 1, -1);
  if (!remaining.length || remaining.some(turn => isVerifiedStaffTurn(turn)))
    return null;
  const firstNextCustomer = remaining.findIndex(turn => turn.role === "user");
  const acknowledgements = remaining.slice(
    0, firstNextCustomer < 0 ? remaining.length : firstNextCustomer
  );
  if (!acknowledgements.some(turn => turn.role === "assistant" &&
      findServicesInText(pricingMessageText(turn), candidates)
        .includes(selected.name))) return null;

  for (const turn of remaining) {
    const value = pricingMessageText(turn).trim();
    if (!value) return null;
    if (turn.role === "user") {
      if (RESET.test(value) || DIFFERENT_UNCONFIGURED_SUBJECT.test(value) ||
          hasClinicalMediaRisk(value)) return null;
      const names = [...new Set(findServicesInText(value, candidates))];
      if (names.some(name => name !== selected.name)) return null;
      if (NON_TREATMENT_FEE.test(value) && hasExplicitPriceRequest(value))
        return null;
    } else if (assistantIntroducesCompetingPaidService(
      turn, selected.name, candidates
    ) && !isSafeFreeAssessmentExplanation(
      turn, selected.name, candidates, complimentaryAssessmentExperienceEnabled
    )) {
      return null;
    }
  }
  return selected;
}

// Backward-compatible name used by PR #630's tests.
const resolveReturningFirstTrialPriceService = resolveReturningTreatmentPriceService;

function clarifyFreeAssessmentAndPaidTrial({
  customerText, conversationHistory = [], treatment, reply,
  complimentaryAssessmentExperienceEnabled = false, language = "zh",
} = {}) {
  const value = String(reply || "").trim();
  if (!value || !treatment || complimentaryAssessmentExperienceEnabled !== true ||
      !FIRST_TRIAL.test(String(customerText || "")) ||
      !conversationHistory.some(turn => turn?.role === "assistant" &&
        FREE_INTRO.test(pricingMessageText(turn)))) return value;
  const locale = String(language || "zh").toLowerCase();
  const note = locale.startsWith("ms")
    ? "Penilaian postur 1-ke-1 bersama sesi pengenalan yang percuma tidak dikenakan bayaran. Harga di bawah adalah untuk pakej rawatan berbayar yang berasingan."
    : locale.startsWith("en")
      ? "The complimentary 1-on-1 posture assessment and introductory experience are free. The prices below are for separate paid treatment packages."
      : "先说明一下：之前提到的免费1对1体态评估＋体验是不收费的 😊 以下是正式护理的收费配套，两者是不同的项目哦。";
  return note + "\n\n" + value;
}

module.exports = {
  resolveReturningTreatmentPriceService, resolveReturningFirstTrialPriceService,
  clarifyFreeAssessmentAndPaidTrial,
};
