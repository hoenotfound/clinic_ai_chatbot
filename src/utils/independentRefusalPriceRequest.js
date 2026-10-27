"use strict";

// A very narrow exception to whole-message quotation refusals:
// "9D不要报价了，我想问3D多少钱？" contains a refusal about 9D and
// an independent, explicit request about 3D. Both service identities must
// come from the customer's CURRENT message, not the model or attribution.
// Conflicting/ambiguous wording fails closed; no inherited service is used.
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");

const REFUSED_QUOTE = /(?:不要|不用|不需要|不想|无需|無需|别|別|請勿|请勿)\s*(?:再|给我|給我|帮我|幫我)?\s*(?:报价|報價|价格|價格|价钱|價錢|优惠价|優惠價|quote|quotation)|\b(?:don't|do not|no)\s+(?:need|want)\s+(?:the\s+)?(?:price|quote|quotation)\b/iu;
const DELIMITER = /[，,;；。\n]|(?:但(?:是)?|不过|不過|可是)|\bbut\b/iu;
const HIGH_RISK = /(?:不要任何|全部都不要|所有都不要|别再|別再|停止|退订|退訂|unsubscribe|opt\s*out|stop\s+messaging|不要发消息|不要發消息|不接受任何|不要联系|不要聯繫|不要再联系|不要再聯繫|别再联系|別再聯繫|不要再联络|不要再聯絡|别再发|別再發)/iu;

function resolveIndependentRefusalPriceRequest({
  customerText, services = [], serviceAliases = [],
} = {}) {
  const raw = String(customerText || "").normalize("NFKC").trim();
  if (!raw || raw.length > 180 || HIGH_RISK.test(raw) || !DELIMITER.test(raw)) return null;
  const clauses = raw.split(/[，,;；。\n]|(?:但(?:是)?|不过|不過|可是)|\bbut\b/iu)
    .map(x => x.trim()).filter(Boolean);
  // Only support one explicit refusal followed by one independent request.
  // More clauses require normal clarification, not automatic sending.
  if (clauses.length !== 2 || !REFUSED_QUOTE.test(clauses[0]) ||
      REFUSED_QUOTE.test(clauses[1])) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  const mentioned = (part) => [...new Set(findServicesInText(part, candidates))];
  const refused = mentioned(clauses[0]);
  const requested = mentioned(clauses[1]);
  if (refused.length !== 1 || requested.length !== 1 ||
      refused[0] === requested[0]) return null;
  // Refused service is deliberately negated; safeServiceFromCustomer
  // correctly excludes such a mention. It is evidence of what NOT to quote.
  const requestedService = safeServiceFromCustomer(clauses[1], services, serviceAliases);
  if (!requestedService || requestedService.name !== requested[0] ||
      !hasExplicitPriceRequest(clauses[1])) return null;
  return Object.freeze({
    treatment: requested[0],
    refusedTreatment: refused[0],
    priceText: clauses[1],
  });
}

module.exports = { resolveIndependentRefusalPriceRequest };
