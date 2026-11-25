"use strict";

const { checkKeywordTriggers } = require("./attentionTriggers");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { detectMessageLanguage } = require("./chatLanguage");

// This is a narrow business-fact safety net, not a replacement for natural AI
// replies. It runs only when a clearly administrative comment was needlessly
// flagged or the generated answer deferred facts that are already configured.
const BUSINESS_LOCATION = /(?:分店|分行|門店|门店|店铺|店舖|診所|诊所|地址|(?:branch|outlet|clinic|shop|store|address|business location)\b|cawangan|klinik|kedai|alamat)/iu;
const LOCATION_QUESTION = /(?:[?？]|吗|嗎|哪里|哪裡|在哪|有在|有没有|有沒有|有吗|有嗎|地址|地点|地點|\b(?:where|which|any|do you have|is there|are there|near|located|location|ada|mana|dekat|di mana|kat mana)\b)/iu;
const HOURS_QUESTION = /(?:营业时间|營業時間|营业到几点|營業到幾點|几点开|幾點開|几时开|幾時開|几点关|幾點關|几点关门|开门时间|開門時間|\b(?:opening hours|business hours|operating hours|what time|when (?:do you )?(?:open|close)|waktu operasi|waktu buka|pukul berapa)\b)/iu;
const OTHER_ENQUIRY = /(?:RM\s*\d+|多少钱|多少錢|价格|價錢|价钱|优惠|優惠|套餐|配套|疗程|療程|护理|護理|治疗|治療|预约|預約|招聘|求职|工作|工作机会|\b(?:price|cost|fee|discount|promo|package|treatment|therapy|booking|appointment|job|hiring|career|service)\b)/iu;
const DEFERRAL = /(?:向.{0,14}(?:团队|團隊|同事|员工|員工|店员|店員).{0,14}(?:确认|確認|核实|核實|问|問)|(?:确认|確認|核实|核實|问一下|問一下|查一下|查詢).{0,30}(?:分店|分行|门店|門店|位置|地址)|(?:稍后|稍後|之后|之後|再).{0,14}(?:回复|回覆|告诉|告訴)|\b(?:check|confirm|verify|ask)\b.{0,60}\b(?:team|staff|branch|outlet|location|address)\b|\b(?:get back to you|follow up with you)\b|(?:semak|tanya|sahkan).{0,35}(?:team|staf|cawangan|lokasi|alamat))/iu;

function verifiedAnswerKind(customerText) {
  const text = String(customerText || "").trim();
  if (!text || text.length > 160 || OTHER_ENQUIRY.test(text) ||
      checkKeywordTriggers(text) || hasClinicalMediaRisk(text)) return null;
  const location = BUSINESS_LOCATION.test(text) && LOCATION_QUESTION.test(text);
  const hours = HOURS_QUESTION.test(text);
  // Do not substitute a single-topic answer for a question about two topics.
  if (location && hours) return null;
  return hours ? "hours" : location ? "location" : null;
}

function safeKnownLocation(config, language) {
  const branches = (Array.isArray(config?.branches) ? config.branches : [])
    .filter((item) => item && String(item.name || "").trim() &&
      String(item.address || "").trim());
  // Never select an arbitrary branch or infer coverage from an incomplete list.
  if (branches.length !== 1 ||
      branches.length !== (Array.isArray(config?.branches) ? config.branches.length : 0)) return null;
  const name = String(branches[0].name).trim();
  const address = String(branches[0].address).trim();
  const isClinic = ["tcm_clinic", "aesthetic_clinic"].includes(config?.businessType);
  if (language === "ms") return "Lokasi kami yang disahkan ialah " + name + " 😊\nAlamat: " + address;
  if (language === "en") return "Our currently confirmed " + (isClinic ? "clinic location" : "location") + " is " + name + " 😊\nAddress: " + address;
  return "我们目前确认的" + (isClinic ? "门店" : "营业地点") + "在 " + name + " 哦 😊\n地址：" + address;
}

function safeKnownHours(config, language) {
  const branches = Array.isArray(config?.branches) ? config.branches : [];
  // Shared hours are not necessarily correct for each branch of a multi-site business.
  if (branches.length !== 1 || !branches[0]?.address) return null;
  const general = String(config?.hours?.general || "").trim();
  const closed = String(config?.hours?.closed || "").trim();
  if (!general) return null;
  const value = [general, closed].filter(Boolean).join("; ");
  if (language === "ms") return "Waktu operasi kami: " + value + " 😊";
  if (language === "en") return "Our opening hours are: " + value + " 😊";
  return "我们的营业时间是：" + value + " 😊";
}

function correctVerifiedCommentBusinessReply({ customerText = "", copy, config } = {}) {
  if (!copy || copy.deterministicSafety || copy.shouldRespond === false) return copy;
  const kind = verifiedAnswerKind(customerText);
  if (!kind) return copy;
  const text = [copy.privateReply, copy.publicReply].filter(Boolean).join("\n");
  if (!copy.flagged && !DEFERRAL.test(text)) return copy;

  const language = detectMessageLanguage(customerText) || "zh";
  const answer = kind === "location"
    ? safeKnownLocation(config, language)
    : safeKnownHours(config, language);
  if (!answer) return copy;

  return {
    ...copy,
    privateReply: answer,
    publicReply: answer,
    flagged: false,
    attentionReason: null,
  };
}

module.exports = {
  correctVerifiedCommentBusinessReply,
  verifiedAnswerKind,
};
