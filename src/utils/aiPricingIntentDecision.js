"use strict";

// The model decides what was asked; only customer-authored, unambiguous service
// evidence can authorize an outbound price/graphic. Ads and bot guesses cannot.
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { stripFutureFollowUpPermission } = require("./customerEnquiryEvidence");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");

const RESET = /(?:换个|換個|改聊|另外想|先不聊|不聊这个|不聊這個|其他话题|其他話題|不要这个|不要這個|不想了解|(?:\b(?:instead|rather|switch|different treatment|another treatment|not interested|stop|unsubscribe)\b))/iu;
const REFUSAL = /(?:不要(?:价格|價格|價錢|价钱|优惠|優惠|促销|促銷)|不用(?:报价|報價|价格|價格)|别(?:报|報)价|\b(?:do not|don't|no)\s+(?:send|want|need)\b.{0,35}\b(?:price|promo|offer)\b)/iu;
const STAFF_PREFIX = /^\[Verified STAFF message\]/u;

function resolveAiPricingIntent({
  intent, customerText, conversationHistory = [], services = [],
  serviceAliases = [], allowOfferEnquiries = false,
  complimentaryAssessmentExperienceEnabled = false,
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || !intent || typeof intent !== "object" ||
      !["price", "package_options"].includes(intent.type) ||
      (intent.type === "package_options" && !allowOfferEnquiries) ||
      !["current_customer", "recent_customer"].includes(intent.source) ||
      RESET.test(current) || REFUSAL.test(current) ||
      hasClinicalMediaRisk(current) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;

  // Future promotional consent is not permission to send an offer now. Only
  // independent pricing wording surviving the consent-stripper may qualify.
  const stripped = stripFutureFollowUpPermission(current);
  if (stripped.hasFuturePermission &&
      !/(?:价|價|多少钱|多少錢|几钱|幾錢|优惠价|優惠價|\b(?:price|pricing|cost|how much|harga|berapa bayar)\b)/iu.test(stripped.text)) {
    return null;
  }

  const candidates = serviceCandidates(services, serviceAliases);
  const currentMatches = [...new Set(findServicesInText(current, candidates))];
  if (currentMatches.length > 1) return null;
  const currentNamed = safeServiceFromCustomer(current, services, serviceAliases);
  if (currentMatches.length === 1 && !currentNamed) return null;

  let source = "current_customer";
  let named = currentNamed;
  if (!named) {
    if (intent.source !== "recent_customer" || currentMatches.length) return null;
    const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
    let skipCurrent = true;
    let previousCustomer = null;
    // Do not bridge staff messages or a topic change to older customer intent.
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const entry = turns[i];
      if (!entry || !["user", "assistant"].includes(entry.role)) continue;
      if (entry.role === "assistant") {
        if (STAFF_PREFIX.test(String(entry.content || "").trim())) return null;
        continue;
      }
      if (skipCurrent && String(entry.content || "").trim() === current) {
        skipCurrent = false;
        continue;
      }
      previousCustomer = String(entry.content || "").trim();
      break;
    }
    if (!previousCustomer || RESET.test(previousCustomer) || REFUSAL.test(previousCustomer)) return null;
    const matches = [...new Set(findServicesInText(previousCustomer, candidates))];
    if (matches.length !== 1) return null;
    named = safeServiceFromCustomer(previousCustomer, services, serviceAliases);
    if (!named) return null;
    source = "recent_customer";
  }

  if (intent.source !== source || named.name !== intent.treatment ||
      !services.some(service => service.name === named.name)) return null;

  return Object.freeze({
    type: intent.type,
    treatment: named.name,
    source,
    // Package selection is deliberately NOT granted by the model. Existing
    // customer-text/package validation handles this independently.
  });
}

module.exports = { resolveAiPricingIntent };
