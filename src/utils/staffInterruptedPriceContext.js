"use strict";

// Staff intervention clears AUTOMATIC price authority. It does not erase what
// service a customer and a subsequent bot reply visibly discussed. This
// resolver is for a non-numeric acknowledgement only; NEVER feed its result
// into price/package/media authorization.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const {
  pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread,
} = require("./priceFollowUpContext");

const MAX_RECENT_MS = 15 * 60 * 1000;
const QUESTION_RESET =
  /(?:其他|其它|另外|换个|換個|全部|所有|都想|比较|比較|不要|不想|没兴趣|沒興趣|改聊|换话题|換話題|stop|unsubscribe|opt\\s*out|another\\s+treatment|other\\s+treatment|different\\s+treatment|instead|all\\s+(?:treatments?|prices?))/iu;
const CONCERN_CONTINUATION =
  /(?:紧致|緊緻|松弛|鬆弛|下颚线|下顎線|下巴|轮廓|輪廓|法令纹|法令紋|脸型|臉型|脸部|臉部|面颊|面頰|皮肤|皮膚|小腹|腰臀|体态|體態|肩颈|肩頸|骨盆|盆骨|下垂|jawline|firmness|contour|facial|pelvis|posture)/iu;
const OTHER_FEE_TOPIC =
  /(?:评估|評估|体验|體驗|免费|免費|押金|订金|訂金|voucher|coupon|baucar|优惠券|優惠券|assessment\\b|deposit\\b)/iu;
const ENQUIRY =
  /(?:想了解|想知道|想问|想問|有兴趣|有興趣|感兴趣|感興趣|interested|enquir|inquir|nak\\s+tahu|mahu\\s+tahu|berminat)/iu;

function uniqueServiceMentions(content, candidates) {
  return [...new Set(findServicesInText(content, candidates))];
}

function resolveStaffInterruptedPriceContext({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || current.length > 90 || !hasExplicitPriceRequest(current) ||
      hasClinicalMediaRisk(current) || QUESTION_RESET.test(current) ||
      OTHER_FEE_TOPIC.test(current) ||
      !Number.isFinite(now)) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  if (uniqueServiceMentions(current, candidates).length) return null;

  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(turn => turn?.role === "user" || turn?.role === "assistant");
  if (turns.length < 5 || turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current) return null;

  const assistant = turns.at(-2);
  if (assistant?.role !== "assistant" || isVerifiedStaffTurn(assistant)) return null;
  const assistantNames = uniqueServiceMentions(pricingMessageText(assistant), candidates);
  if (assistantNames.length !== 1) return null;
  const serviceName = assistantNames[0];
  const lastStaffIndex = turns.findLastIndex(isVerifiedStaffTurn);
  if (lastStaffIndex < 1 || lastStaffIndex >= turns.length - 2) return null;

  // A recently staff-interrupted conversation may retain only a verbal
  // reference, not permission to quote any amount. Require a real customer
  // selection BEFORE staff, and a customer concern answer AFTER staff.
  const afterStaff = turns.slice(lastStaffIndex + 1, -1);
  const customersAfterStaff = afterStaff.filter(turn => turn.role === "user");
  if (!customersAfterStaff.length ||
      !customersAfterStaff.some(turn =>
        CONCERN_CONTINUATION.test(pricingMessageText(turn)))) return null;

  let selectedAt = -1;
  for (let i = lastStaffIndex - 1; i >= 0; i--) {
    if (turns[i].role !== "user") continue;
    const source = pricingMessageText(turns[i]).trim();
    if (QUESTION_RESET.test(source)) return null;
    const names = uniqueServiceMentions(source, candidates);
    if (names.length > 1) return null;
    if (!names.length) continue;
    const selected = safeServiceFromCustomer(source, services, serviceAliases);
    if (!selected || selected.name !== serviceName ||
        names[0] !== serviceName || !ENQUIRY.test(source)) return null;
    selectedAt = i;
    break;
  }
  if (selectedAt < 0 || !isRecentPricingThread(turns, selectedAt, now) ||
      now - turns[selectedAt].pricingCreatedAtMs > MAX_RECENT_MS) return null;
  for (const turn of turns.slice(selectedAt + 1, -1)) {
    const message = pricingMessageText(turn).trim();
    if ((turn.role === "user" || isVerifiedStaffTurn(turn)) &&
        QUESTION_RESET.test(message)) return null;
    const names = uniqueServiceMentions(message, candidates);
    if (names.some(name => name !== serviceName) || names.length > 1) return null;
    if (turn.role === "user" && hasClinicalMediaRisk(message)) return null;
  }
  return serviceName;
}

function formatStaffInterruptedPriceContext(serviceName, language = "zh") {
  const locale = String(language || "").toLowerCase();
  if (locale.startsWith("ms")) {
    return `Kita sedang berbincang tentang ${serviceName} 😊 Harga terkini rawatan ini perlu disahkan oleh pihak pusat supaya saya tidak berikan jumlah yang salah.`;
  }
  if (locale.startsWith("en")) {
    return `We were discussing ${serviceName} 😊 The centre needs to confirm the latest price so I don't give you an incorrect amount.`;
  }
  return `我们刚刚聊的是【${serviceName}】😊 这项疗程的最新配套价格需要由门店核实，避免给你错误的报价。`;
}

module.exports = {
  resolveStaffInterruptedPriceContext, formatStaffInterruptedPriceContext,
};
