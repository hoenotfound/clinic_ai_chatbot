"use strict";

const { hasClinicalMediaRisk } = require("./aiReviewPolicy");

// A technical question about the actual 9D machine is not the same as an
// individual medical suitability or procedure-timing question. The clinic
// knows that 9D is device-based, but has not verified a manufacturer/model.
const DEVICE_QUESTION =
  /^(?:(?:what|which|whose|do\s+you\s+know)\b.{0,65}\b(?:device|machine|equipment|instrument)\b.{0,35}|\b(?:device|machine)\b.{0,35}\b(?:brand|model|name|type|which|what)\b|(?:用|使用|采用|採用).{0,12}(?:什么|什麼|哪[个個款种種])?.{0,8}(?:仪器|儀器|机器|機器|设备|設備)|(?:什么|什麼|哪[个個款种種]).{0,14}(?:仪器|儀器|机器|機器|设备|設備)|(?:mesin|alat)\s+(?:apa|jenis\s+apa|jenama\s+apa)|(?:apa|jenama|jenis)\s+(?:mesin|alat))[\s?!?？。.!！]*$/iu;
const PREVIOUS_9D_DEVICE =
  /(?:9\s*d|逆龄抗衰|逆齡抗衰)/iu;
const DEVICE_DESCRIPTION =
  /(?:device|machine|equipment|仪器|儀器|机器|機器|设备|設備|mesin|alat)/iu;
const STAFF_PREFIX = /^\[Verified STAFF message\]/u;
const MAX_THREAD_MS = 3 * 60 * 60 * 1000;

function resolveNeutroFacialDeviceReview({
  customerText, conversationHistory = [], services = [], language = "en",
  now = Date.now(),
} = {}) {
  const question = String(customerText || "").trim();
  if (!question || question.length > 110 || !DEVICE_QUESTION.test(question) ||
      hasClinicalMediaRisk(question) ||
      !services.some(item => item?.name === "9D 逆龄抗衰")) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(t => t?.role === "user" || t?.role === "assistant");
  if (turns.length < 3 || turns.at(-1)?.role !== "user" ||
      String(turns.at(-1)?.content || "").trim() !== question) return null;

  const recent = turns.filter(t =>
    Number.isFinite(t?.pricingCreatedAtMs) &&
    t.pricingCreatedAtMs >= now - MAX_THREAD_MS &&
    t.pricingCreatedAtMs <= now + 60_000);
  if (recent.length < 3 || recent.at(-1) !== turns.at(-1) ||
      recent.some(t => t.pricingStaffAuthored === true ||
        (t.role === "assistant" && STAFF_PREFIX.test(String(t.content || ""))))) return null;
  const previousAssistant = recent.findLastIndex(t => t.role === "assistant");
  if (previousAssistant < 0) return null;
  const explanation = String(recent[previousAssistant].content || "");
  if (!PREVIOUS_9D_DEVICE.test(explanation) ||
      !DEVICE_DESCRIPTION.test(explanation)) return null;
  // A repeated unanswered request is the only allowed intervening customer
  // turn. A new concern or treatment change must not inherit an old 9D topic.
  if (recent.slice(previousAssistant + 1, -1).some(t =>
    t.role !== "user" || !DEVICE_QUESTION.test(String(t.content || "").trim()) ||
    hasClinicalMediaRisk(String(t.content || "")))) return null;

  const locale = String(language || "").toLowerCase();
  const reply = locale.startsWith("zh")
    ? "9D 是仪器类的脸部紧致提升护理 😊 不过目前我这里没有经过门店确认的仪器品牌和型号，所以不想给你错误资料。我会请门店同事帮你确认具体使用哪一款仪器。"
    : locale.startsWith("ms")
      ? "Rawatan wajah 9D kami menggunakan alat untuk penjagaan keanjalan wajah 😊 Tetapi jenama dan model mesin belum disahkan dalam maklumat saya. Saya akan minta staf pusat mengesahkan model yang digunakan."
      : "Our 9D facial treatment is device-based 😊 I don't have a verified brand or machine model to share, so I don't want to give you incorrect details. I'll ask our team to confirm the exact device for you.";
  return { reply, reviewType: "information", reason: "unverified_9d_device_specification" };
}

module.exports = { resolveNeutroFacialDeviceReview, DEVICE_QUESTION };
