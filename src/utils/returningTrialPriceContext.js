"use strict";

// Neutro-only Shadow exception for a returning first-trial PRICE question.
// The original 24-hour pricing session remains unchanged. This path requires
// an unambiguous customer-selected treatment and a complete, trusted,
// staff-free conversation across scheduled automatic follow-ups.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const {
  pricingMessageText, isVerifiedStaffTurn, assistantIntroducesCompetingPaidService,
} = require("./priceFollowUpContext");

const MAX_TREATMENT_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CURRENT_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const FIRST_TRIAL = /(?:第一次|首次|初次)\s*(?:体验|體驗|护理|護理|疗程|療程|做|来|來)?|\b(?:first[\s-]*trial|trial[\s-]*(?:price|cost)|harga[\s-]*percubaan)\b/iu;
const NON_TREATMENT_FEE = /(?:免费|免費|评估|評估|assessment|consultation|deposit|订金|訂金|预约费|預約費|booking[\s-]*fee|admin(?:istration)?[\s-]*fee)/iu;
const NEW_TOPIC_OR_BROAD = /(?:换个|換個|另外|其他|其它|别的|別的|全部|所有|两个|兩個|两项|兩項|不想|不要|退订|退訂|\b(?:instead|another|other[\s-]*treatment|all[\s-]*treatments|unsubscribe|stop)\b)/iu;
const CUSTOMER_TREATMENT_INTEREST = /(?:有兴趣|有興趣|感兴趣|感興趣|想了解|想知道|想问|想問|interested|enquir|inquir|berminat|nak\s+tahu|mahu\s+tahu)/iu;

function resolveReturningFirstTrialPriceService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  complimentaryAssessmentExperienceEnabled = false, now = Date.now(),
} = {}) {
  const current = String(customerText || "").normalize("NFKC").trim();
  if (!current || current.length > 100 || !Number.isFinite(now) ||
      !FIRST_TRIAL.test(current) || !hasExplicitPriceRequest(current) ||
      NEW_TOPIC_OR_BROAD.test(current) || NON_TREATMENT_FEE.test(current) ||
      hasClinicalMediaRisk(current) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  // This path is ONLY for a reference back to a customer-named treatment.
  // Current explicitly named/multiple services use the existing price routes.
  if (findServicesInText(current, candidates).length) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(turn => turn?.role === "user" || turn?.role === "assistant");
  if (turns.length < 3 || turns.length > 22 ||
      turns[0].role !== "user" || turns.at(-1).role !== "user" ||
      pricingMessageText(turns.at(-1)).normalize("NFKC").trim() !== current) return null;

  // Reject truncated histories and any intervening customer discussion rather
  // than guessing that an older marketing/CRM service still applies.
  const customerTurns = turns.filter(turn => turn.role === "user");
  if (customerTurns.length !== 2 || customerTurns[0] !== turns[0]) return null;
  const firstText = pricingMessageText(turns[0]).trim();
  const chosen = safeServiceFromCustomer(firstText, services, serviceAliases);
  const names = [...new Set(findServicesInText(firstText, candidates))];
  if (!chosen || names.length !== 1 || names[0] !== chosen.name ||
      !CUSTOMER_TREATMENT_INTEREST.test(firstText) ||
      NEW_TOPIC_OR_BROAD.test(firstText) || hasClinicalMediaRisk(firstText)) return null;

  // Every source timestamp must come from the DB, be chronological and fall
  // within the bounded seven-day treatment conversation.
  let previousAt = -Infinity;
  const earliest = now - MAX_TREATMENT_CONTEXT_AGE_MS;
  for (const turn of turns) {
    const at = turn.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at < earliest || at > now + 60_000 ||
        at < previousAt) return null;
    previousAt = at;
  }
  if (now - turns.at(-1).pricingCreatedAtMs > MAX_CURRENT_MESSAGE_AGE_MS ||
      turns.at(-1).pricingCreatedAtMs <= turns[0].pricingCreatedAtMs) return null;

  const replies = turns.slice(1, -1);
  if (!replies.length ||
      replies.some(turn => turn.role !== "assistant" ||
        isVerifiedStaffTurn(turn) || !pricingMessageText(turn).trim() ||
        assistantIntroducesCompetingPaidService(turn, chosen.name, candidates))) return null;
  // A bot cannot create price authority by mentioning its own suggested
  // treatment. It must first acknowledge the treatment selected by the customer.
  const firstReplyNames = findServicesInText(pricingMessageText(replies[0]), candidates);
  if (!firstReplyNames.includes(chosen.name)) return null;
  return chosen;
}

module.exports = { resolveReturningFirstTrialPriceService };
