"use strict";

// This is a text-only response for repeat-visit pricing. It never licenses an
// advertised first-trial amount, a promotional image, or a booking action.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isRecentPricingThread, isVerifiedStaffTurn, pricingMessageText } = require("./priceFollowUpContext");
const { serviceCandidates, findServicesInText, NON_TREATMENT_ANCHOR_PATTERN } = require("./conversationPromptContext");

const SECOND_VISIT = /(?:第\s*[二兩两2]\s*(?:次|回)|(?:下次|下一次|再做|续做|續做|后续|後續|之后|之後|往后|往後)\s*(?:做|护理|護理|疗程|療程|收费|收費|价|價)?|(?:正常|原)[价價]|(?:单次|單次|每次|每回)(?:收[费費]|[价價]|多少钱|多少錢)?|\b(?:second|subsequent|repeat|next)\s+(?:session|visit|treatment)|\bafter\s+(?:the\s+)?(?:first\s+)?(?:session|visit|treatment|trial|promotion|promo)|\b(?:normal|regular)\s+(?:session\s+)?(?:price|rate|fee)|\b(?:per[\s-]?session|individual[\s-]?session)\s*(?:price|cost|rate|fee)?|\b(?:kali|sesi|rawatan)\s+(?:kedua|seterusnya)\b)/iu;
const PRICE_WORDS = /(?:价钱|價錢|价格|價格|价位|價位|收费|收費|费用|費用|多少钱|多少錢|几多钱|幾多錢|\bhow\s+much\b|\b(?:price|cost|charge|fee|rate|harga|berapa)\b)/iu;
const TOPIC_RESET = /(?:换个(?:疗程|療程|护理|護理)|換個(?:療程|护理|護理)|改聊|换话题|換話題|另外想(?:了解|问|問)(?:别的|別的|其他)|不要(?:这个|這個)(?:疗程|療程|护理|護理)|(?:不要|不想做|不考虑|不考慮|没兴趣|沒興趣)\s*(?:3D|9D)(?:\s*小颜术|\s*逆龄)?|不想(?:做|了解)(?:这个|這個)(?:疗程|療程|护理|護理)|\b(?:switch\s+treatment|another\s+treatment|different\s+treatment|not\s+interested\s+in\s+this\s+treatment|stop|unsubscribe)\b)/iu;
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
  if (!turns.length || turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      !Number.isFinite(turns.at(-1)?.pricingCreatedAtMs) ||
      turns.at(-1).pricingCreatedAtMs > now + 60_000 ||
      now - turns.at(-1).pricingCreatedAtMs > MAX_SESSION_AGE_MS ||
      turns.some(turn => isVerifiedStaffTurn(turn) ||
        (turn.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn))))) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  // General 1-on-1 assessment invitations are not competing paid treatments.
  const treatmentMentions = value => findServicesInText(value, candidates)
    .filter(name => !NON_TREATMENT_ANCHOR_PATTERN.test(name));
  // A clearly customer-NAMED service is stronger than the older context.
  // This also protects "3D second session price" from being treated as a
  // request for the RM488 first-trial graphic.
  const currentServices = [...new Set(treatmentMentions(current))];
  if (currentServices.length > 1) return null;
  const earlier = turns.slice(0, -1);
  let selected = currentServices[0] || null;
  let selectionAt = -1;
  for (let index = selected ? -1 : earlier.length - 1; index >= 0; index--) {
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
  // Contextual replies need both a recent customer-authored selection and a
  // matching accepted assistant turn. Current explicit naming is sufficient
  // on its own and does not require a previous bot to have repeated the name.
  if (selectionAt === -1) return { treatment: selected };
  if (!isRecentPricingThread(turns, selectionAt, now)) return null;
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
