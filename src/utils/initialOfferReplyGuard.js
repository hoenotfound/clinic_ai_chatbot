"use strict";

const { withPelvicSpellingAliases } = require("./pelvicSpellingAliases");

const { pruneCoveredServiceMentions } = require("./serviceMentionResolution");
const { relatedPricingConflict, configuredServiceMention, unpricedRelatedPrimary } = require("./relatedServicePolicy");

const {
  hasCustomerPriceEnquiry,
  hasExplicitPriceRequest,
  isStandalonePriceQuestion,
  hasCustomerServiceEnquiry,
  isContextualAdServiceEnquiry,
} = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const clinicConfig = require("../config/clinicConfig");
const { templateText, verifiedPelvicAssessmentVoucher } = require("./clinicAssessmentReplyTemplates");
const { SESSION_RESULT_QUESTION } = require("./verifiedResultMediaExample");
const { adaptNeutroAppointmentInvitation, isNeutroBusiness } =
  require("./appointmentInviteContinuity");

// A final outbound boundary for a first WhatsApp message without a current
// price enquiry. Consent detection must not control unsolicited price safety.
// Replace commercial model output with deterministic conversational copy.
// Bare numbers may be phone numbers, address units or durations, not prices.
// Merely describing Package A and Package B is not a price or promotion.
const COMMERCIAL_REPLY_CONTENT =
  /(?:\b(?:rm|myr)(?=\d|\s|[^\p{L}\p{N}]|$)|\b(?:ringgit|pricing|prices?|costs?|fees?|charges?|promos?|promotions?|discounts?|deals?|vouchers?|coupons?|offers?|sales?|harga|promosi|tawaran|diskaun|percuma|gifts?|bonuses?|rebates?|cashbacks?)\b|\b(?:free|complimentary)\b.{0,50}\b(?:massage|gift|session|treatment|trial|consultation|add[-\s]?on|bonus)\b|(?:first[\s-]*trial|trial[\s-]*price)|令吉|[价價][钱錢格位]|优惠|優惠|促销|促銷|折扣|限时|限時|特价|特價|赠|贈|礼遇|禮遇|免费|免費|原价|原價|现价|現價|只需|仅需|僅需|\d{1,3}\s*%\s*(?:off|discount)?|(?:\d\uFE0F?\u20E3){2,})/iu;

const DURATION_REQUEST =
  /(?:多久|多长|多長|几分钟|幾分鐘|几小时|幾小時|\bhow\s+long\b|\bduration\b|\bberapa\s+lama\b)/iu;

// A standalone bare amount, or a plausible treatment/offer amount, must still
// be guarded when Gemini writes "骨盆 388 / 288" without an RM prefix.
// Avoid interpreting phone numbers, address codes, years, session counts and
// clinical durations as sales amounts.
const BARE_AMOUNT = /(?<![A-Za-z0-9])[1-9]\d{2,4}(?![A-Za-z0-9])/gu;
const BARE_PRICE_CONTEXT = /(?:骨盆|小颜|小顏|逆龄|逆齡|护理|護理|疗程|療程|调理|調理|价|價|套餐|配套|体验|體驗|首单|首單|仅|僅|只要|现在|現在|起|每次|\b(?:3d|9d|pelvic|treatment|package|trial|offer|promo|only|just|from|starting|cost|price|for|per\s+session|harga|pakej|rawatan)\b)/iu;
const CONTACT_OR_ADDRESS_CONTEXT = /(?:电话|電話|联络|聯絡|联系|聯繫|号码|號碼|地址|邮编|郵編|楼|樓|门牌|門牌|\b(?:call|phone|contact|tel|whatsapp|address|postcode|unit|suite|block|nombor|telefon|alamat)\b)/iu;
const NON_PRICE_NUMBER_SUFFIX = /^\s*(?:\+\s*(?:体态案例|體態案例|案例|顾客|顧客|客户|客戶|患者|个|個|人|位|例|\b(?:cases?|clients?|customers?|patients?)\b)|年|月|日|人|位|个|個|次|分钟|分鐘|小时|小時|岁|歲|例|名|天|周|週|星期|%|\b(?:years?|months?|days?|hours?|minutes?|mins?|people|times|sessions?|cases?|patients?|weeks?|percent)\b)/iu;

function hasBarePriceContent(value) {
  const content = String(value || "").normalize("NFKC");
  for (const clause of content.split(/[，,。.!！?？;；\n]+/u)) {
    const ranges = [...clause.matchAll(/(?:\+?\d[\d\s()-]{7,}\d)/gu)]
      .filter((match) => match[0].replace(/\D/gu, "").length >= 8)
      .map((match) => [match.index, match.index + match[0].length]);
    const candidates = [...clause.matchAll(BARE_AMOUNT)].filter((match) => {
      const value = match[0], index = match.index;
      if (/^(?:19|20)\d{2}$/u.test(value)) return false;
      if (ranges.some(([start, end]) => index >= start && index + value.length <= end)) return false;
      const prefix = clause.slice(Math.max(0, index - 48), index);
      // An earlier address/phone label only exempts numbers belonging to that
      // field. If a treatment or price phrase appears AFTER that label, a
      // separate amount must still be treated as a possible unsolicited price.
      const adminTerms = [...prefix.matchAll(
        new RegExp(CONTACT_OR_ADDRESS_CONTEXT.source, "giu")
      )];
      const lastAdmin = adminTerms[adminTerms.length - 1];
      if (lastAdmin) {
        const afterAdmin = prefix.slice(lastAdmin.index + lastAdmin[0].length);
        if (!BARE_PRICE_CONTEXT.test(afterAdmin)) return false;
      }
      if (NON_PRICE_NUMBER_SUFFIX.test(clause.slice(index + value.length))) return false;
      return true;
    });
    if (!candidates.length) continue;
    const bareOnly = /^\s*[1-9]\d{2,4}\s*$/u.test(clause);
    const multipleAmounts = candidates.length >= 2 &&
      /(?:\/|和|或|及|\bor\b|\band\b)/iu.test(clause);
    if (bareOnly || multipleAmounts || BARE_PRICE_CONTEXT.test(clause)) return true;
  }
  return false;
}

function hasCommercialReplyContent(value) {
  const normalized = String(value || "").normalize("NFKC");
  return COMMERCIAL_REPLY_CONTENT.test(normalized) || hasBarePriceContent(normalized);
}

// Match configured service names/aliases against their actual text spans.
// Removing punctuation first would make "3D、9D" look identical to the
// configured "3D+9D" combination and could mistakenly prioritize a combo.
function safeServiceFromCustomer(customerText, services, serviceAliases = []) {
  const source = String(customerText || "").normalize("NFKC").toLowerCase();
  const normalizeKey = (value) => String(value || "").normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const byName = new Map();
  for (const service of Array.isArray(services) ? services : []) {
    const key = normalizeKey(service?.name);
    if (key.length >= 2) byName.set(key, service);
  }
  const mentions = new Map();
  const negated = (start, end) => {
    const preceding = source.slice(Math.max(0, start - 32), start);
    const following = source.slice(end, end + 28);
    return /(?:不要|不是|不想(?:做|了解)?|不考虑|不考慮|不需要|不选|不選|不喜欢|不喜歡|拒绝|拒絕|don't\s+want|do\s+not\s+want|not\s+interested\s+in|tak\s+nak|tidak\s+mahu)\s*$/iu.test(preceding) ||
      /^(?:\s*(?:护理|療程|疗程|treatment|rawatan)\s*)?(?:没兴趣|沒興趣|不要|不想做|不考虑|不考慮|不需要)/iu.test(following);
  };
  const addMentions = (service, rawTerm) => {
    const term = String(rawTerm || "").normalize("NFKC").toLowerCase().trim();
    if (normalizeKey(term).length < 2) return;
    // Preserve "+", word boundaries and contiguous canonical names.
    // Whitespace in configured names may vary in customer messages.
    const parts = [];
    for (const char of term) {
      if (/\s/u.test(char)) parts.push("\\s*");
      else if (char === "+") parts.push("\\s*\\+\\s*");
      else parts.push(char.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&"));
    }
    const asciiStart = /^[a-z0-9]/u.test(term);
    const asciiEnd = /[a-z0-9]$/u.test(term);
    const prefix = asciiStart ? "(^|[^a-z0-9])" : "";
    const suffix = asciiEnd ? "(?=$|[^a-z0-9])" : "";
    const pattern = new RegExp(prefix + parts.join("") + suffix, "giu");
    for (const match of source.matchAll(pattern)) {
      const start = match.index + (asciiStart ? match[1].length : 0);
      const end = match.index + match[0].length;
      if (negated(start, end)) continue;
      const key = normalizeKey(service.name);
      if (!mentions.has(key)) mentions.set(key, { service, spans: [] });
      mentions.get(key).spans.push({ start, end });
    }
  };

  for (const service of byName.values()) addMentions(service, service.name);
  for (const alias of withPelvicSpellingAliases(services, serviceAliases)) {
    const canonical = byName.get(normalizeKey(alias?.officialService));
    if (!canonical) continue;
    for (const term of String(alias?.alias || "").split(/[,|;，、]+/u)) {
      addMentions(canonical, term);
    }
  }
  const entries = pruneCoveredServiceMentions([...mentions.values()]);
  if (!entries.length) return null;

  const combos = entries.filter(({ service }) =>
    /[+＋&]|组合|組合|\b(?:combo|combination)\b/iu.test(service.name)
  );
  if (combos.length === 1) {
    // "3D+9D" can match both constituent aliases as well as the combo;
    // choose the combo only if every constituent mention is inside a full
    // combo mention. A separate pelvic or 3D/9D request is ambiguous.
    const combination = combos[0];
    const extra = entries.filter((entry) => entry !== combination).some((entry) =>
      entry.spans.some((span) => !combination.spans.some((whole) =>
        whole.start <= span.start && whole.end >= span.end
      ))
    );
    if (!extra && !hasCommercialReplyContent(combination.service.name)) {
      return combination.service;
    }
    return null;
  }
  if (combos.length > 1 || entries.length !== 1) return null;
  return hasCommercialReplyContent(entries[0].service.name) ? null : entries[0].service;
}

function safeIntroReply({ customerText, language, services, serviceAliases = [] }) {
  const service = safeServiceFromCustomer(customerText, services, serviceAliases);
  const name = String(service?.name || "").trim();
  const duration = String(service?.duration || "").trim();
  const includeDuration = name && DURATION_REQUEST.test(customerText) &&
    duration && duration.length <= 100 &&
    !hasCommercialReplyContent(duration);
  const locale = String(language || "").toLowerCase();
  const chinese = locale.startsWith("zh") ||
    (!locale && /[\u3400-\u9fff]/u.test(customerText));
  const malay = locale.startsWith("ms");

  if (chinese) {
    if (includeDuration) {
      return "Hi～" + name + "的护理时间通常是" + duration + " 😊\n你比较想了解护理过程，还是想先看看适不适合自己呢？";
    }
    return name
      ? "Hi～欢迎了解" + name + " 😊\n我可以先跟你介绍护理方式。你目前最想了解或改善哪一方面呢？"
      : "Hi～欢迎咨询 😊\n你目前最想了解哪一种护理，或想改善哪方面呢？";
  }
  if (malay) {
    if (includeDuration) {
      return "Hai! Tempoh rawatan " + name + " biasanya " + duration + " 😊\nApa lagi yang anda ingin tahu tentang proses rawatan?";
    }
    return name
      ? "Hai! Boleh saya terangkan lebih lanjut tentang " + name + " 😊\nBahagian mana yang anda paling ingin tahu atau perbaiki?"
      : "Hai! Terima kasih kerana menghubungi kami 😊\nRawatan atau masalah yang mana anda ingin tahu lebih lanjut?";
  }
  if (includeDuration) {
    return "Hi! " + name + " usually takes " + duration + " 😊\nWould you like to know more about how the treatment works?";
  }
  return name
    ? "Hi! Happy to share more about " + name + " 😊\nWhat would you most like to know or improve?"
    : "Hi! Thanks for getting in touch 😊\nWhich treatment would you like to know more about?";
}

/**
 * Validate the FULL assembled reply (including the configured business intro)
 * before durable message reservation or provider send.
 * Preserve escalation, AI flags, result images and existing duplicate guards.
 */
function guardFutureOfferIntroductionReply({
  channel,
  isFirstMessage,
  customerText,
  reply,
  flagged = false,
  language = "en",
  services = [],
  serviceAliases = [],
} = {}) {
  const original = String(reply || "");
  if (String(channel || "").toLowerCase() !== "whatsapp" ||
      isFirstMessage !== true || flagged === true ||
      hasCustomerPriceEnquiry(customerText) ||
      !hasCommercialReplyContent(original)) {
    return { reply: original, replaced: false };
  }
  const safe = safeIntroReply({ customerText, language, services, serviceAliases });
  // Even misconfigured service names and durations must never bypass the gate.
  if (hasCommercialReplyContent(safe)) {
    return {
      reply: "Hi! Thanks for getting in touch 😊 What would you most like to know about the treatment?",
      replaced: true,
    };
  }
  return { reply: safe, replaced: true };
}

// This guard runs after the full customer-facing text is assembled. It is
// scoped by the caller to assessment-first clients, on any channel or turn.
function hasTreatmentPriceContent(reply) {
  const original = String(reply || "").normalize("NFKC");
  const withoutVoucher = original
    .replace(/\b(?:RM|MYR)\s*100(?=\s*(?:voucher|coupon|discount|off|baucar|优惠券|優惠券|折扣券|抵用券))/giu, "[VOUCHER]")
    .replace(/(?:voucher|coupon|baucar|优惠券|優惠券|抵用券|折扣券)\s*(?:worth\s*)?(?:RM|MYR)\s*100\b/giu, "[VOUCHER]")
    .replace(/\b(?:RM|MYR)\s*100(?=\s*(?:的)?\s*(?:骨盆(?:调理|調理))?\s*(?:疗程|療程)?\s*(?:优惠券|優惠券|抵用券))/giu, "[VOUCHER]");
  return /\b(?:RM|MYR)\s*(?:[0-9]|[0-9]️⃣)|(?:[0-9]️⃣){2,}|(?:原价|原價|现价|現價|只需|仅需|僅需|价格是|價錢是|(?:price|cost)\s*(?:is|:)|harga\s*(?:ialah|:))/iu.test(withoutVoucher) ||
    hasBarePriceContent(withoutVoucher);
}

function assessmentFirstInvitation({ treatment, customerText, language = "en", services = [], serviceAliases = [] } = {}) {
  // Only customer-verified service interest may select a treatment-specific invitation.
  // Package A's AI body scan is NOT verified as part of the free introductory
  // assessment. Never promise it (or a free paid facial trial) in this invitation.
  const matched = safeServiceFromCustomer(customerText, services, serviceAliases);
  const canonical = (Array.isArray(services) ? services : [])
    .find(service => String(service?.name || "").trim() === String(treatment || "").trim());
  const service = canonical || matched;
  const name = String(service?.name || "").trim();
  const isPelvis = name === "骨盆调理";
  const isFace = /(?:\b[39]\s*d\b|小颜|小顏|逆龄|逆齡|面部|脸部|臉部|facial|face)/iu.test(name);
  const isBodyPosture = isPelvis || /(?:体态|體態|骨盆|产后|產後|posture|pelvi[cs])/iu.test(name);
  const locale = String(language || "").toLowerCase();
  const zh = locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(customerText));
  const ms = locale.startsWith("ms");
  if (isNeutroBusiness(clinicConfig)) {
    const kind = isPelvis
      ? (clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true
        ? "pelvicFree" : "pelvicStandard")
      : isFace ? "face" : isBodyPosture ? "body" : "general";
    const configuredIntro = templateText(clinicConfig, language, kind, name);
    const configuredQuestion = templateText(clinicConfig, language, "dayQuestion");
    if (configuredIntro && configuredQuestion) {
      const voucher = isPelvis && verifiedPelvicAssessmentVoucher(clinicConfig)
        ? templateText(clinicConfig, language, "voucher") : null;
      return [configuredIntro, voucher, configuredQuestion].filter(Boolean).join("\n");
    }
  }

  const dayQuestion = zh
    ? "\n你哪一天比较方便来呢？我可以帮你向门店确认预约时间～"
    : ms
      ? "\nHari apa yang sesuai untuk datang? Saya boleh semak masa dengan pusat dahulu."
      : "\nWhich day would suit you to visit? I can check the appointment time with the clinic.";

  if (isPelvis) {
    const free = clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true;
    const intro = zh
      ? free
        ? "我们可以先帮你安排免费1对1的体态评估 + 体验，让中医师了解你的体态和身体困扰，再看看适合怎样调理 😊"
        : "我们可以先帮你安排中医师1对1的体态评估 + 体验，了解你的体态和身体困扰，再看看适合怎样调理 😊"
      : ms
        ? (free ? "Boleh mula dengan penilaian postur 1-ke-1 dan sesi pengenalan percuma" : "Boleh mula dengan penilaian postur 1-ke-1 dan sesi pengenalan") +
          " bersama pengamal TCM untuk fahami keadaan badan sebelum berbincang tentang rawatan yang sesuai 😊"
        : (free ? "We can arrange a complimentary 1-on-1 posture assessment and introductory experience" : "We can arrange a 1-on-1 posture assessment and introductory experience") +
          " so our TCM practitioner can understand your concerns before discussing suitable care 😊";
    const voucher = zh
      ? "到店完成评估 + 体验，还可以领取 RM100 骨盆调理疗程优惠券，具体使用条件由门店确认。"
      : ms
        ? "Selepas hadir, anda juga boleh menerima baucar RM100 untuk rawatan pelvis, tertakluk pada syarat pusat."
        : "After attending, you may also receive an RM100 pelvic-treatment voucher, subject to the clinic's conditions.";
    return intro + "\n" + voucher + dayQuestion;
  }
  if (isFace) {
    const intro = zh
      ? "我们可以先帮你安排中医师1对1脸部评估，了解你在意的脸型或紧致问题，再看看" + name + "是否适合你 ❤️"
      : ms
        ? "Kami boleh aturkan penilaian wajah 1-ke-1 bersama pengamal TCM untuk fahami keperluan anda sebelum bincang rawatan yang sesuai 😊"
        : "We can arrange a 1-on-1 facial assessment with our TCM practitioner to understand your concerns before discussing suitable options 😊";
    return intro + dayQuestion;
  }
  if (name) {
    const intro = zh
      ? isBodyPosture
        ? "可以先让中医师帮你做1对1体态评估 + 入门体验，了解你的身体状况与困扰，再看看适合怎样调理 ❤️"
        : "可以先安排中医师1对1评估，了解你目前的困扰，再看看" + name + "是否适合你 ❤️"
      : ms
        ? "Pengamal TCM boleh buat penilaian 1-ke-1 dahulu untuk fahami keperluan anda sebelum bincang rawatan yang sesuai 😊"
        : "Our TCM practitioner can first assess your concerns one-to-one before discussing whether " + name + " may be suitable 😊";
    return intro + dayQuestion;
  }
  return safeIntroReply({ customerText, language, services, serviceAliases });
}

function ensureFirstAssessmentInvitation({
  isFirstMessage = false, customerText, reply, flagged = false,
  language = "en", treatment = null, serviceQuery = false,
  verifiedAdService = null, services = [], serviceAliases = [],
} = {}) {
  const original = String(reply || "").trim();
  if (!isFirstMessage || flagged || !original ||
      SESSION_RESULT_QUESTION.test(String(customerText || "")) ||
      hasClinicalMediaRisk(customerText) ||
      hasExplicitPriceRequest(customerText, { treatment }) ||
      !hasCustomerServiceEnquiry(customerText)) {
    return { reply: original, appended: false };
  }
  const verified = safeServiceFromCustomer(customerText, services, serviceAliases);
  const verifiedCreative = isContextualAdServiceEnquiry(customerText)
    ? (Array.isArray(services) ? services : []).find(
        item => item?.name === verifiedAdService && item?.name === treatment
      )
    : null;
  const service = verified || verifiedCreative;
  if (!service) return { reply: original, appended: false };
  // Do not promise an automatic voucher, an extra RM100 reduction or a free
  // trial. Voucher copy is intentionally governed separately from invitation.
  const lang = String(language || "").toLowerCase();
  const chinese = lang.startsWith("zh") || (!lang && /[\u3400-\u9fff]/u.test(customerText));
  const malay = lang.startsWith("ms");
  const alreadyInvited = /(?:1\s*[对對]\s*1|1\s*[-–]?\s*on\s*[-–]?\s*1|one\s*[-–]?\s*on\s*[-–]?\s*one|penilaian\s*(?:postur)?|体态评估|體態評估|面部评估|面部評估)/iu.test(original);
  const hasVoucher = /\b(?:RM|MYR)\s*100\b/iu.test(original);
  // Strengthen a short existing assessment invitation without replacing a
  // useful answer or adding a second booking question. This only changes
  // Neutro conversations; a mere reference to a 1-to-1 assessment is not
  // itself permission to push an appointment.
  const neutro = isNeutroBusiness(clinicConfig);
  const configuredValueNote = neutro
    ? templateText(clinicConfig, language,
        service.name === "骨盆调理" ? "valuePelvic"
          : /(?:3D|9D|小颜|逆龄|面部|脸部)/iu.test(service.name) ? "valueFace"
            : "valueGeneral", service.name)
    : null;
  const valueNote = configuredValueNote || (chinese
    ? service.name === "骨盆调理"
      ? "中医师会先了解你的体态和身体困扰，再看看适合怎样调理 ❤️"
      : /(?:3D|9D|小颜|逆龄|面部|脸部)/iu.test(service.name)
        ? "中医师会先了解你在意的脸型和紧致问题，再看看适合哪种护理 ❤️"
        : "中医师会先了解你目前在意的身体状况，再看看适合怎样调理 ❤️"
    : malay
      ? "Pengamal TCM akan fahamkan keadaan dan keperluan anda dahulu sebelum bincang rawatan yang sesuai 😊"
      : "Our TCM practitioner will first understand your concerns before discussing suitable care 😊");
  const hasValue = /(?:了解|瞭解|明白|认识|認識|fahami|memahami|understand).{0,70}(?:体态|體態|身体|身體|困扰|困擾|情况|狀況|需要|需求|脸型|臉型|紧致|緊緻|care|concerns?|needs?|condition|rawatan|keperluan)/iu.test(original);
  const looksLikeInvite = /(?:安排|预约|預約|来做|來做|先来|先來|过来|過來|到店|想先|想不想|book|arrange|come|visit|appointment|atur|datang)/iu.test(original);
  const isAlreadyBooked = /(?:已预约|已預約|已确认|已確認|confirmed appointment|already booked|temu janji disahkan)/iu.test(original);
  if (alreadyInvited) {
    let enriched = original;
    if (neutro && looksLikeInvite && !hasValue && !isAlreadyBooked) {
      // Put the reason for visiting BEFORE the existing scheduling question.
      const bookingQuestion = /(?:你比较方便|你比較方便|你哪一天|你下星期|您想先安排|你想先安排|which day|what day|would a weekday|hari apa|hari biasa|hujung minggu)/iu;
      const match = bookingQuestion.exec(enriched);
      enriched = match
        ? enriched.slice(0, match.index).trimEnd() + "\n" + valueNote + "\n" + enriched.slice(match.index)
        : enriched + "\n" + valueNote;
    }
    enriched = adaptNeutroAppointmentInvitation({
      message: enriched, customerTexts: [customerText], language,
      businessConfig: clinicConfig,
    });
    if (service.name === "骨盆调理" && !hasVoucher &&
        (!neutro || !templateText(clinicConfig, language, "voucher") ||
         verifiedPelvicAssessmentVoucher(clinicConfig))) {
      const configuredVoucher = neutro
        ? templateText(clinicConfig, language, "voucher") : null;
      const voucherNote = configuredVoucher || (chinese
        ? "到店完成评估 + 体验，还可以领取 RM100 骨盆调理疗程优惠券，具体使用条件由门店确认 🎁"
        : malay
          ? "Selepas hadir untuk penilaian + sesi percubaan, anda juga boleh menerima baucar RM100 untuk rawatan pelvis. Syarat ditegaskan oleh pusat."
          : "After attending the assessment + trial, you can also receive an RM100 pelvic-treatment voucher. Our centre will confirm redemption conditions.");
      enriched += "\n\n" + voucherNote;
    }
    return { reply: enriched, appended: enriched !== original };
  }
  const invitation = assessmentFirstInvitation({
    treatment: service.name, customerText, language, services, serviceAliases,
  });
  // The AI may already have ended its answer with a useful question.
  // Do not append a second booking question just because we added value.
  const oneQuestionInvitation = /[?？]\s*$/u.test(original)
    ? invitation.replace(/\n[^\n]*[?？][^\n]*$/u, "").trim()
    : invitation;
  const adaptedInvitation = adaptNeutroAppointmentInvitation({
    message: oneQuestionInvitation || invitation, customerTexts: [customerText],
    language, businessConfig: clinicConfig,
  });
  return { reply: original + "\n\n" + adaptedInvitation, appended: true };
}

// This is conversational continuity only, never authority to quote a price.
function continuedConversationFallback({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  promotions = [], language = "en", isFirstMessage = true,
} = {}) {
  if (isFirstMessage || !Array.isArray(conversationHistory) ||
      conversationHistory.length < 3) return null;
  const current = conversationHistory.at(-1);
  const previousCustomer = conversationHistory.slice(0, -1).reverse()
    .find(turn => turn?.role === "user");
  const now = Date.now();
  if (current?.role !== "user" || !previousCustomer ||
      String(current.content || "").trim() !== String(customerText || "").trim() ||
      !Number.isFinite(current.pricingCreatedAtMs) ||
      !Number.isFinite(previousCustomer.pricingCreatedAtMs) ||
      current.pricingCreatedAtMs > now + 60_000 ||
      now - current.pricingCreatedAtMs > 3 * 60 * 60 * 1000 ||
      current.pricingCreatedAtMs - previousCustomer.pricingCreatedAtMs > 3 * 60 * 60 * 1000 ||
      conversationHistory.some(turn => turn?.pricingStaffAuthored === true ||
        (turn?.role === "assistant" &&
          /^\[Verified STAFF message\]/u.test(String(turn.content || ""))))) return null;

  // Reuse the existing topic-change/negation checks. Assistant statements may
  // help the natural reply stay on-topic, but never permit a monetary quote.
  const { recentConversationServiceAnchor, serviceCandidates } =
    require("./conversationPromptContext");
  const anchor = recentConversationServiceAnchor(
    conversationHistory, serviceCandidates(services, serviceAliases), 16, promotions
  );
  const name = anchor?.relevantServiceNames?.length === 1
    ? anchor.relevantServiceNames[0] : null;
  const locale = String(language || "").toLowerCase();
  const zh = locale.startsWith("zh") ||
    (!locale && /[\u3400-\u9fff]/u.test(customerText));
  const ms = locale.startsWith("ms");
  const askedPrice = hasExplicitPriceRequest(customerText);
  let reply;
  if (zh) {
    reply = askedPrice
      ? name
        ? "你之前咨询的是" + name + " 😊 这项收费我暂时无法核对准确金额，需要由门店同事确认，避免给错报价。"
        : "我明白你在询问收费 😊 我需要先确认具体项目，才能请同事核对准确价格。"
      : /预算|預算/u.test(customerText)
        ? "明白，你有预算上的考虑 😊" +
          (name ? " 关于" + name + "，" : " ") +
          "方便告诉我大概的预算范围吗？我可以帮你记录给同事。"
        : /整体脸型|整體臉型|脸型|臉型/u.test(customerText) && name
          ? "明白，你主要在意整体脸型和轮廓 😊 我们继续聊" + name + "，我可以进一步介绍护理方式。"
          : "好的，我们继续聊" + (name || "你刚才咨询的护理") +
            " 😊 你想进一步确认哪一部分呢？";
  } else if (ms) {
    reply = askedPrice
      ? "Saya faham anda sedang bertanya tentang harga" +
        (name ? " " + name : "") + ". Pihak pusat perlu sahkan jumlah sebenar dahulu."
      : "Baik, kita sambung tentang " + (name || "rawatan yang anda tanya") +
        " 😊 Apa lagi yang anda ingin tahu?";
  } else {
    reply = askedPrice
      ? "You're asking about the price" + (name ? " of " + name : "") +
        " 😊 Our team needs to confirm the correct amount before I quote it."
      : "Let's continue with " + (name || "the treatment you asked about") +
        " 😊 What would you like to check next?";
  }
  return { reply, treatment: name };
}

function isRepeatedWelcome(reply) {
  return /^(?:Hi[～~!,.， ]*欢迎咨询|Hi[～~!,.， ]*欢迎了解|Hi! Thanks for getting in touch|Hai! Terima kasih kerana menghubungi kami)/iu
    .test(String(reply || "").trim());
}

function stripUnsolicitedTreatmentPrice(reply) {
  const source = String(reply || "").trim();
  // Preserve complete, useful non-price sentences instead of throwing away
  // the whole reply. Never preserve a sentence containing a suspicious amount.
  const segments = source.split(/(?<=[。！？!?;\n])|(?<=\.)\s+(?=[A-Z])/u);
  const retained = segments.filter(segment => !hasTreatmentPriceContent(segment))
    .join("").trim();
  return retained && !hasTreatmentPriceContent(retained) ? retained : "";
}

// When a clinic requires customer-grounded treatment evidence, a direct
// monetary question by itself never authorizes a model-selected service price.
// The only trusted treatment at this boundary is one independently resolved
// from the current or immediately previous customer message by the caller.
function guardAssessmentFirstPricingReply({
  customerText, reply, flagged = false, language = "en",
  services = [], serviceAliases = [], treatment = null,
  requireVerifiedTreatment = false, clarifiedPriceService = null,
  verifiedPricingIntent = false,
  resultMedia = [], conversationHistory = [], promotions = [],
  allowContinuedPriceContext = false, isFirstMessage = true,
} = {}) {
  const original = String(reply || "");
  if (flagged) return { reply: original, replaced: false };
  const continuing = continuedConversationFallback({
    customerText, conversationHistory, services, serviceAliases,
    promotions, language, isFirstMessage,
  });
  if (!hasTreatmentPriceContent(original)) {
    return continuing && isRepeatedWelcome(original)
      ? { reply: continuing.reply, replaced: true }
      : { reply: original, replaced: false };
  }
  // A single independently approved pricing decision has already checked
  // the customer-selected treatment, active price and related-service safety.
  // Do not let this later guard recalculate the conversation and veto it.
  if (verifiedPricingIntent === true && Boolean(treatment) &&
      !hasClinicalMediaRisk(customerText)) {
    return { reply: original, replaced: false };
  }
  // A related result-photo link is NOT a license to quote that other
  // treatment's package price. Protect full-body care even when the AI
  // correctly names the original service but invents a pelvic package cost.
  const relatedConflict = relatedPricingConflict({
    customerText, treatment, conversationHistory,
    services, serviceAliases, resultMedia,
  });
  const unpricedPrimary = unpricedRelatedPrimary({
    customerText, conversationHistory, services, serviceAliases, resultMedia,
  });
  // Delayed import avoids a require cycle: the price-context module uses
  // safeServiceFromCustomer exported by this module.
  const { resolveContinuedTreatmentPriceService, resolveRecentFirstTreatmentPriceService } = require("./priceFollowUpContext");
  const verifiedContinuedService =
    resolveRecentFirstTreatmentPriceService({
      customerText, conversationHistory, services, serviceAliases, promotions,
    })?.name === treatment ||
    (allowContinuedPriceContext === true &&
      resolveContinuedTreatmentPriceService({
        customerText, conversationHistory, services, serviceAliases, promotions,
      })?.name === treatment);
  if ((relatedConflict || unpricedPrimary) && !verifiedContinuedService) {
    const primary = unpricedPrimary ||
      configuredServiceMention(customerText, services, serviceAliases) ||
      (Array.isArray(conversationHistory)
        ? [...conversationHistory].reverse()
          .filter((entry) => entry?.role === "user")
          .map((entry) => configuredServiceMention(entry.content, services, serviceAliases))
          .find(Boolean)
        : null);
    const locale = String(language || "").toLowerCase();
    const clarification = locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(customerText))
      ? "这项调理的实际费用需要由门店根据具体项目确认。"
      : locale.startsWith("ms")
        ? "Harga rawatan ini perlu disahkan oleh pihak pusat berdasarkan rawatan yang sesuai."
        : "The centre will confirm the price for the specific treatment.";
    const invitation = assessmentFirstInvitation({
      treatment: primary, customerText, language, services, serviceAliases,
    });
    return { reply: [clarification, invitation].filter(Boolean).join("\n"), replaced: true };
  }
  const priceAsked = (verifiedPricingIntent === true && Boolean(treatment)) ||
    hasExplicitPriceRequest(customerText, { treatment }) ||
    (Boolean(treatment) && clarifiedPriceService === treatment);
  if (priceAsked && (!requireVerifiedTreatment || Boolean(treatment))) {
    return { reply: original, replaced: false };
  }
  // An unverified treatment and a price question require clarification, not
  // Gemini's guessed RM amount. This also covers mixed-treatment enquiries
  // without arbitrarily choosing one package.
  if (requireVerifiedTreatment && !treatment &&
      (priceAsked || isStandalonePriceQuestion(customerText))) {
    const locale = String(language || "").toLowerCase();
    const clarification = locale.startsWith("zh") || (!locale && /[\u3400-\u9fff]/u.test(customerText))
      ? "请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊"
      : locale.startsWith("ms")
        ? "Boleh saya tahu harga untuk rawatan yang mana satu ya? 😊"
        : "Which treatment would you like the price for? I can help you check 😊";
    return { reply: continuing?.treatment ? continuing.reply : clarification, replaced: true };
  }
  const retained = stripUnsolicitedTreatmentPrice(original);
  const fallback = hasClinicalMediaRisk(customerText)
    ? safeIntroReply({ customerText, language, services, serviceAliases })
    : assessmentFirstInvitation({ treatment, customerText, language, services, serviceAliases });
  return { reply: retained && !isRepeatedWelcome(retained)
    ? retained : continuing?.reply || retained || fallback, replaced: true };
}
module.exports = {
  guardAssessmentFirstPricingReply,
  ensureFirstAssessmentInvitation,
  safeServiceFromCustomer,
  assessmentFirstInvitation,
  stripUnsolicitedTreatmentPrice,
  hasTreatmentPriceContent,
  guardFutureOfferIntroductionReply,
  hasCommercialReplyContent,
  safeIntroReply,
};
