"use strict";

// Dedicated event package, intentionally separate from the standing RM388
// full-body Pulse Wave offer. Nothing here changes configured service prices.
const CAMPAIGN_KEY = "neutro_breast_rm68_2026";
const PREFILL = "你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？";
const MYT_DEC_6_START = Date.parse("2026-12-05T16:00:00.000Z");
const MYT_CAMPAIGN_END = Date.parse("2026-12-06T16:00:00.000Z");
const INTRO_MARKER = "我们目前推出【胸部专业检查 + 脉冲波疏通乳腺护理】限时体验优惠";

function normalize(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}
function isExactPrefill(value) {
  return normalize(value) === normalize(PREFILL);
}
function isNeutro(businessName) {
  return /^neutro\s+sense\s+tcm(?:\s+centre)?$/iu.test(String(businessName || "").trim());
}
function campaignCreativeMatches(metaAdContext) {
  if (!metaAdContext || typeof metaAdContext !== "object") return false;
  // Headline/body originate in the saved current-lead Meta referral. The
  // separately enriched ad/campaign names are useful when creative is sparse.
  // Never use the customer's prefill itself to prove what the ad advertised.
  const source = [
    metaAdContext.headline, metaAdContext.body,
    metaAdContext.adName, metaAdContext.campaignName,
  ].filter(Boolean).join(" ");
  return /\b(?:RM|MYR)\s*68\b/iu.test(source) &&
    /(?:胸部|乳腺|乳房|breast|payudara)/iu.test(source);
}
function campaignDay(now = Date.now()) {
  const time = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(time)) return "expired";
  if (time >= MYT_CAMPAIGN_END) return "expired";
  if (time >= MYT_DEC_6_START) return "dec6";
  return "both";
}
function dayLine(now = Date.now()) {
  const day = campaignDay(now);
  return day === "both" ? "12月5日 & 6日" : day === "dec6" ? "12月6日" : "";
}
function dayQuestion(now = Date.now()) {
  return campaignDay(now) === "dec6"
    ? "请问您12月6日（星期日）方便吗？😊"
    : "请问您比较方便 12月5日（星期六）还是12月6日（星期日） 呢？😊";
}

function firstReply(now = Date.now()) {
  if (campaignDay(now) === "expired") {
    return [
      "您好💕 欢迎咨询 Neutro Sense TCM！",
      "",
      "12月5日及6日的体验活动已经结束了。如想了解目前的胸部护理项目或预约安排，我们可以帮您向门店确认哦 😊",
    ].join("\n");
  }
  return [
    "您好💕 欢迎咨询 Neutro Sense TCM！",
    "",
    INTRO_MARKER + " 🌸",
    "",
    "✨ 首次体验只需 RM68（原价以门店公告为准）",
    "📅 活动日期：" + dayLine(now),
    "⏰ 全程约 1小时30分钟",
    "",
    "护理包含：",
    "✅ 专业胸部健康评估",
    "✅ 脉冲波舒缓护理，帮助放松胸部周围组织",
    "✅ 胸部日常护理建议",
    "",
    "💗 名额有限，需要提前预约哦！",
    "",
    dayQuestion(now),
  ].join("\n");
}
function isCampaignOpening(text) {
  const raw = String(text || "");
  return raw.includes(INTRO_MARKER) && raw.includes("首次体验只需 RM68") &&
    raw.includes("全程约 1小时30分钟");
}
function hasCampaignConversation(history) {
  const messages = Array.isArray(history) ? history : [];
  const first = messages.findIndex(row => row?.role === "user" && isExactPrefill(row.content));
  return first >= 0 && messages.slice(first + 1).some(
    row => row?.role === "assistant" && isCampaignOpening(row.content)
  );
}

const OTHER_TREATMENT = /(?:\b(?:3\s*d|9\s*d|hifu|facial|pelvic|postpartum)\b|骨盆|小颜|小顏|逆龄|逆齡|产后|產後|子宫|子宮|艾灸|体态|體態|全身脉冲|全身脈衝)/iu;
const EXIT_CAMPAIGN = /(?:不想了解|不想要|换个|換個|另外想|改聊|停止|退订|退訂|取消活动|取消活動|\b(?:stop|unsubscribe|not interested|switch treatment|another service|cancel promotion)\b)/iu;
function isOtherTreatmentQuery(text) {
  return OTHER_TREATMENT.test(String(text || "")) || EXIT_CAMPAIGN.test(String(text || ""));
}
const CAMPAIGN_QUERY =
  /(?:胸部|乳腺|乳房|脉冲|脈衝|专业检查|專業檢查|评估|評估|RM\s*68|RM\s*388|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|便宜|包括|包含|做什么|做什麼|什么项目|什麼項目|多久|多长|多長|时间|時間|小时|小時|日期|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:price|cost|fee|duration|how long|hours?|breast|pulse|rm ?68|rm ?388|appointment|availability|slot|december [56]|5th|6th)\b)/iu;
const AMOUNT_QUESTION =
  /(?:RM\s*(?:68|388)|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|\b(?:price|cost|fee|how much|harga)\b)/iu;
const DURATION_QUESTION =
  /(?:多久|多长|多長|时间|時間|小时|小時|\b(?:duration|how long|hour|hours|lama)\b)/iu;
const INCLUDES_QUESTION =
  /(?:包括|包含|做什么|做什麼|什么项目|什麼項目|护理什么|護理什麼|\b(?:include|included|what do|consist)\b)/iu;
const DATE_QUESTION =
  /(?:日期|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:appointment|availability|slot|december [56]|5th|6th)\b)/iu;

function stillDiscussingCampaign(history) {
  const messages = Array.isArray(history) ? history : [];
  const opener = messages.findIndex(row => row?.role === "assistant" &&
    isCampaignOpening(row.content));
  return opener >= 0 && !messages.slice(opener + 1, -1).some(
    row => row?.role === "user" && isOtherTreatmentQuery(row.content)
  );
}
function campaignContextReply({ history, customerText, now = Date.now() } = {}) {
  if (!hasCampaignConversation(history) || !stillDiscussingCampaign(history) ||
      !CAMPAIGN_QUERY.test(String(customerText || "")) ||
      isOtherTreatmentQuery(customerText)) return null;
  if (campaignDay(now) === "expired") {
    return "您之前咨询的 RM68 胸部护理体验活动已于12月6日结束。若想了解现在的护理安排，可以由门店帮您确认哦 😊";
  }
  const dates = dayLine(now);
  const text = String(customerText || "");
  if (DATE_QUESTION.test(text)) {
    // Never imply that a date, place, or appointment is confirmed.
    return "RM68 胸部健康评估 + 脉冲波舒缓护理的活动日期是" + dates +
      "，全程约1小时30分钟。具体名额需要由门店确认哦 😊 " + dayQuestion(now);
  }
  if (AMOUNT_QUESTION.test(text)) {
    return "您咨询的【胸部健康评估 + 脉冲波舒缓护理】12月活动首次体验是 RM68，全程约1小时30分钟。" +
      "这是独立活动，不是一般 RM388 的全身脉冲波护理。名额以门店确认为准 😊";
  }
  if (DURATION_QUESTION.test(text)) {
    return "这个 RM68 胸部健康评估 + 脉冲波舒缓护理活动，全程约1小时30分钟，活动日期为" +
      dates + "。想预约可以先告诉我们方便的日期，由门店确认名额哦 😊";
  }
  if (INCLUDES_QUESTION.test(text)) {
    return "RM68 首次体验包含专业胸部健康评估、脉冲波舒缓护理，以及胸部日常护理建议；全程约1小时30分钟。" +
      "这项护理不等于医院的乳腺癌筛查或医学诊断 😊";
  }
  return "您之前咨询的【胸部健康评估 + 脉冲波舒缓护理】首次体验 RM68，活动日期为" +
    dates + "，全程约1小时30分钟。名额需要由门店确认哦 😊";
}

function guardCampaignPriceConflicts({ history, customerText, reply, now = Date.now() } = {}) {
  const original = String(reply || "");
  if (!hasCampaignConversation(history) || !stillDiscussingCampaign(history) ||
      isOtherTreatmentQuery(customerText)) return original;
  if (/(?:RM\s*(?:388|688)|2\s*(?:小时|小時|hours?)\s*15|2h\s*15)/iu.test(original) ||
      (campaignDay(now) === "expired" && /\bRM\s*68\b/iu.test(original)) ||
      (campaignDay(now) === "dec6" && /12月5日/u.test(original))) {
    return campaignContextReply({ history, customerText:
      CAMPAIGN_QUERY.test(String(customerText || "")) ? customerText : "RM68优惠",
      now,
    }) || original;
  }
  return original;
}
function candidateIsCampaign(candidate) {
  const trigger = String(candidate?.trigger_message_content || "");
  const inbounds = [
    ...(Array.isArray(candidate?.recent_inbound_messages) ? candidate.recent_inbound_messages : []),
    ...(Array.isArray(candidate?.recent_service_messages) ? candidate.recent_service_messages : []),
  ];
  // A saved staff-authored outbound text is not an independent Meta receipt.
  // Require the actual ad prefill, and either the original approved opener or
  // independently confirmed creative from the current lead.
  const exactPrefill = inbounds.some(isExactPrefill) || isExactPrefill(trigger);
  const recognizedOpener = isCampaignOpening(trigger);
  const ad = {
    headline: candidate?.ad_followup_headline,
    body: candidate?.ad_followup_body,
    adName: candidate?.ad_followup_ad_name,
    campaignName: candidate?.ad_followup_campaign_name,
  };
  const verifiedAd = candidate?.ad_followup_source === "meta_ads" &&
    campaignCreativeMatches(ad);
  return verifiedAd && (exactPrefill || recognizedOpener);
}
function campaignFollowUp({ candidate, now = Date.now() } = {}) {
  if (!candidateIsCampaign(candidate)) return null;
  // Fresh customer topic switches do not inherit the old event price.
  const latest = (Array.isArray(candidate?.recent_inbound_messages)
    ? candidate.recent_inbound_messages : []).find(v => typeof v === "string" && v.trim());
  if (latest && isOtherTreatmentQuery(latest)) return null;
  const day = campaignDay(now);
  if (day === "expired") return { expired: true, message: null };
  const message = day === "both"
    ? "您好💕 温馨提醒：您之前了解的【胸部健康评估 + 脉冲波舒缓护理】首次体验 RM68，活动日期为12月5日和6日，全程约1小时30分钟。具体名额以门店确认为准，如需安排欢迎回复我们 😊"
    : "您好💕 温馨提醒：您之前了解的【胸部健康评估 + 脉冲波舒缓护理】RM68 活动只剩今天12月6日，全程约1小时30分钟。具体名额以门店确认为准，如需安排欢迎回复我们 😊";
  return { expired: false, message };
}

module.exports = {
  CAMPAIGN_KEY, PREFILL, INTRO_MARKER, MYT_CAMPAIGN_END,
  isNeutro, isExactPrefill, campaignCreativeMatches, campaignDay,
  firstReply, isCampaignOpening, hasCampaignConversation,
  isOtherTreatmentQuery, stillDiscussingCampaign, campaignContextReply, guardCampaignPriceConflicts,
  candidateIsCampaign, campaignFollowUp,
};
