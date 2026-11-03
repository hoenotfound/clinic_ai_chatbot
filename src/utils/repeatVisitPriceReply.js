"use strict";

// This is a text-only response for repeat-visit pricing. It never licenses an
// advertised first-trial amount, a promotional image, or a booking action.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isRecentPricingThread, isVerifiedStaffTurn, pricingMessageText } = require("./priceFollowUpContext");
const { serviceCandidates, findServicesInText, NON_TREATMENT_ANCHOR_PATTERN } = require("./conversationPromptContext");

const SECOND_VISIT = /(?:第\s*[二兩两2]\s*(?:次|回)|(?:下次|下一次|再做|续做|續做|后续|後續|之后|之後|往后|往後)\s*(?:做|护理|護理|疗程|療程|收费|收費|价|價)?|\b(?:second|subsequent|repeat|next)\s+(?:session|visit|treatment)|\bafter\s+(?:the\s+)?first\s+(?:session|visit|treatment|trial)|\bkali\s+kedua\b)/iu;
const PRICE_WORDS = /(?:价钱|價錢|价格|價格|价位|價位|收费|收費|费用|費用|多少钱|多少錢|几多钱|幾多錢|\b(?:price|cost|charge|fee|harga|berapa)\b)/iu;
const TOPIC_RESET = /(?:换个|換個|改聊|换话题|換話題|另外想|不要|不想|不考虑|不考慮|没兴趣|沒興趣|\b(?:switch|instead|another\s+treatment|not\s+interested|stop|unsubscribe)\b)/iu;
const MAX_SESSION_AGE_MS = 3 * 60 * 60 * 1000;

function resolveRepeatVisitPriceReply({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  language = "zh", now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || !SECOND_VISIT.test(current) || !PRICE_WORDS.test(current) ||
      !hasExplicitPriceRequest(current) || TOPIC_RESET.test(current) ||
      hasClinicalMediaRisk(current)) return null;

  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(turn => turn?.role === "user" || turn?.role === "assistant");
  if (turns.length < 3 || turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      !isRecentPricingThread(turns, 0, now) ||
      turns.some(turn => isVerifiedStaffTurn(turn) ||
        (turn.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn))))) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  // General 1-on-1 assessment invitations are not competing paid treatments.
  const treatmentMentions = value => findServicesInText(value, candidates)
    .filter(name => !NON_TREATMENT_ANCHOR_PATTERN.test(name));
  // A customer asking about a new named service must go through the normal
  // single-service clarification/verification, not inherit an older topic.
  if (treatmentMentions(current).length) return null;

  const earlier = turns.slice(0, -1);
  let selected = null;
  let selectionAt = -1;
  for (let index = earlier.length - 1; index >= 0; index--) {
    const turn = earlier[index];
    if (turn.role !== "user") continue;
    const text = pricingMessageText(turn).trim();
    if (TOPIC_RESET.test(text)) return null;
    const names = [...new Set(treatmentMentions(text))];
    if (names.length > 1) return null;
    if (names.length === 1) {
      selected = names[0];
      selectionAt = index;
      break;
    }
  }
  if (!selected) return null;
  const selectedAt = earlier[selectionAt].pricingCreatedAtMs;
  if (!Number.isFinite(selectedAt) || now - selectedAt > MAX_SESSION_AGE_MS) return null;

  // Customer-authored selection AND an actual matching bot reply are required.
  // The ad name, lead CRM label and model-generated treatment label alone
  // cannot establish which repeat-visit price the customer means.
  const subsequent = earlier.slice(selectionAt + 1);
  if (!subsequent.some(turn => turn.role === "assistant" &&
      treatmentMentions(pricingMessageText(turn)).includes(selected))) return null;
  if (subsequent.some(turn => turn.role === "user" &&
      treatmentMentions(pricingMessageText(turn))
        .some(name => name !== selected))) return null;
  if (subsequent.some(turn => turn.role === "assistant" &&
      treatmentMentions(pricingMessageText(turn))
        .some(name => name !== selected))) return null;

  const locale = String(language || "").toLowerCase();
  const reply = locale.startsWith("ms")
    ? "Saya faham, anda bertanya tentang caj sesi kedua untuk " + selected +
      " 😊 Harga percubaan pertama tidak semestinya sama dengan sesi seterusnya. Saya perlu minta staf pusat sahkan harga sebenar supaya tidak beri maklumat yang salah."
    : locale.startsWith("en")
      ? "You're asking about the second session of " + selected +
        " 😊 The first-trial offer may differ from subsequent-session pricing. I'll need our team to confirm the actual amount so I don't give you an incorrect quote."
      : "明白～你问的是" + selected +
        "第一次体验之后，第二次继续护理的收费对吗？😊\n首次体验优惠不一定适用于第二次，后续收费需要由门店同事确认，避免给你错误的价格。";
  return { treatment: selected, reply };
}

module.exports = { resolveRepeatVisitPriceReply };
