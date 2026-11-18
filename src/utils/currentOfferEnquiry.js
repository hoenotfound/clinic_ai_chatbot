"use strict";

// A customer can request a current First Trial/promotion without asking an
// explicit monetary question. This only supplies customer-led intent and a
// bounded, independently selected treatment. It never supplies prices or media.
const { stripFutureFollowUpPermission } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { isVerifiedStaffTurn } = require("./priceFollowUpContext");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");

const OFFER = /(?:优惠|優惠|促销|促銷|特价|特價|折扣|体验价|體驗價|\b(?:promo|promosi|promotions?|offers?|discounts?|deals?|first[\s-]*(?:try|trial)|trial[\s-]*(?:offer|price))\b)/iu;
const SHORT_OFFER = /^(?:优惠|優惠|促销|促銷|特价|特價|first[\s-]*(?:try|trial)|promo|promosi|promotion|offer|discount)[\s?？!！。~]*$/iu;
const DIRECT_REQUEST = /(?:[?？]|吗|嗎|呢|(?:有|有什么|有什麼|有没有|有沒有|想|请问|請問|麻烦|麻煩|发我|發我|给我|給我).{0,65}(?:优惠|優惠|促销|促銷|特价|特價|折扣|first[\s-]*(?:try|trial))|\b(?:any|have|has|available|what|which|show|send|can|could|do|does|ada|boleh|nak|mahu)\b)/iu;
const FUTURE_ONLY = /(?:以后|以後|之后|之後|将来|將來|未来|未來|下个月|下個月|下次有|有优惠再|有優惠再|到时候|到時候|\b(?:next\s+(?:month|time)|later|in\s+the\s+future|when\s+(?:there(?:'s| is)|available))\b)/iu;
const DECLINE = /(?:不要|不用|不需要|不想|拒绝|拒絕|别发|別發|别给|別給).{0,28}(?:优惠|優惠|促销|促銷|折扣|特价|特價|promo|offer|first[\s-]*trial)|\b(?:no|don't|do\s+not|not)\b.{0,24}\b(?:offers?|promos?|discounts?)\b/iu;
const COMMENT_ONLY = /(?:优惠|優惠|折扣|促销|促銷).{0,14}(?:太贵|太貴|太少|不错|不錯|很好|还行|還行|已经看过|已經看過|看过了|看過了|收到了|收到啦)|(?:已经|已經|刚|剛|之前).{0,20}(?:看过|看過|收到)(?:优惠|優惠|促销|促銷)|\b(?:already\s+(?:seen|received)|too\s+expensive|looks\s+good)\b/iu;
const RESET = /(?:换个|換個|改聊|另一|另外|其他|其它|全部|所有|价目表|價目表|不同疗程|不同療程|不想了解|不要这个|不要這個|\b(?:instead|switch|different|another|other\s+treatments?|all\s+(?:the\s+)?(?:prices|treatments)|price\s+list|stop|unsubscribe)\b)/iu;
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

// Future follow-up permission must never be mistaken for a request to send a
// current graphic. An explicit separate current-offer request can still pass.
function isCurrentOfferEnquiry(message) {
  const original = String(message || "").normalize("NFKC").trim();
  if (!original || original.length > 160 || hasClinicalMediaRisk(original) ||
      FUTURE_ONLY.test(original) || DECLINE.test(original) ||
      COMMENT_ONLY.test(original)) return false;
  const current = stripFutureFollowUpPermission(original).text.trim();
  return Boolean(current) && OFFER.test(current) &&
    (SHORT_OFFER.test(current) || DIRECT_REQUEST.test(current));
}

// A model, old CRM service, or ad alone cannot choose a promotion. Require
// the customer to have named one configured treatment and for the bot to have
// acknowledged that treatment within this fresh, staff-free conversation.
// All timestamp and conflict checks are fail-closed.
function resolveCurrentOfferService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  now = Date.now(),
} = {}) {
  if (!isCurrentOfferEnquiry(customerText) || !Number.isFinite(now)) return null;
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const last = turns.at(-1);
  if (last?.role !== "user" ||
      String(last.content || "").trim() !== String(customerText || "").trim()) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  const current = safeServiceFromCustomer(customerText, services, serviceAliases);
  const currentMentions = [...new Set(findServicesInText(customerText, candidates))];
  if (currentMentions.length > 1 || (currentMentions.length && !current)) return null;
  if (current) return current;

  let customerTurns = 0;
  let lastTimestamp = now + 60_000;
  let sawCurrent = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role !== "assistant" && turn?.role !== "user") continue;
    const at = turn.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at > lastTimestamp ||
        at > now + 60_000 || now - at > MAX_AGE_MS) return null;
    lastTimestamp = at;
    if (isVerifiedStaffTurn(turn)) return null;
    if (turn.role !== "user") continue;
    if (!sawCurrent) {
      sawCurrent = true;
      continue;
    }
    customerTurns += 1;
    if (customerTurns > 6) return null;
    const text = String(turn.content || "").trim();
    if (!text || RESET.test(text) || DECLINE.test(text) ||
        hasClinicalMediaRisk(text)) return null;
    const matches = [...new Set(findServicesInText(text, candidates))];
    const named = safeServiceFromCustomer(text, services, serviceAliases);
    if (matches.length > 1 || (matches.length && !named)) return null;
    if (!named) continue;
    const acknowledgements = turns.slice(i + 1, -1).filter(t => t?.role === "assistant");
    if (!acknowledgements.some(t =>
      findServicesInText(String(t.content || ""), candidates).includes(named.name)
    )) return null;
    return named;
  }
  return null;
}

module.exports = { isCurrentOfferEnquiry, resolveCurrentOfferService };
