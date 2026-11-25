"use strict";

// Dedicated event package, intentionally separate from the standing RM388
// full-body Pulse Wave offer. Nothing here changes configured service prices.
const { detectConversationLanguage } = require("./chatLanguage");
const CAMPAIGN_KEY = "neutro_breast_rm68_2026";
const PREFILL = "你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？";
// Keep the legacy Meta ad live while the copy is gradually updated.
// This is only campaign recognition; promotional consent is verified separately.
const FOLLOWUP_PREFILL = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
const MYT_DEC_6_START = Date.parse("2026-12-05T16:00:00.000Z");
const MYT_CAMPAIGN_END = Date.parse("2026-12-06T16:00:00.000Z");
const INTRO_MARKER = "我们目前推出【胸部专业检查 + 脉冲波疏通乳腺护理】限时体验优惠";

function normalize(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}
function isExactPrefill(value) {
  return [PREFILL, FOLLOWUP_PREFILL].some((prefill) => normalize(value) === normalize(prefill));
}
// This recognises a customer explicitly asking about the advertised RM68
// breast-care offer, including shorter/edited Meta prefills. It does NOT
// establish ad attribution or marketing consent. Only the first-turn reply
// policy may use it, after checking clinical, staff, booking and sender gates.
function isSimpleRm68Enquiry(value) {
  if (isExactPrefill(value)) return true;
  const raw = normalize(value);
  if (raw.length < 12 || raw.length > 240 || /[\r\n]/u.test(String(value || ""))) return false;
  if (!/\b(?:RM|MYR)\s*68\b/iu.test(raw) ||
      !/(?:胸部|乳腺|乳房|breast|payudara)/iu.test(raw) ||
      !/(?:专业检查|專業檢查|健康评估|健康評估|护理|護理|体验|體驗|优惠|優惠|assessment|check(?:up)?|care|trial|promotion|promo|offer)/iu.test(raw) ||
      !/(?:我对|我對|想了解|想知道|请问|請問|咨询|諮詢|有兴趣|有興趣|優惠|优惠|体验|體驗|interested|want to know|like to know|berminat|nak tahu|promo|promotion|trial|offer)/iu.test(raw)) return false;
  // Mixed treatments, cancellations, requests for staff or personalised
  // medical/appointment advice must remain in the normal AI/review path.
  if (isOtherTreatmentQuery(raw) ||
      /(?:骨盆|盆骨|3\s*d|9\s*d|子宫|子宮|产后|產後|hifu|facial|pelvic|postpartum|退订|退訂|停止|退款|取消|换个|換個|不感兴趣|不感興趣|没兴趣|沒興趣|人工|客服|员工|員工)/iu.test(raw) ||
      /(?:今天|明天|后天|後天|下午|上午|早上|晚上|今晚|周末|週末|星期[一二三四五六日天]|礼拜[一二三四五六日天]|禮拜[一二三四五六日天]|预约|預約|改期|多少[钱錢]|[价價][钱錢]|多久|多长|多長|包括|包含|副作用|治疗|治療|可以治|是否适合|是否適合|怎么|怎麼|如何|地址|地点|地點|在哪里|在哪裡|\b(?:today|tomorrow|book(?:ing)?|schedule|reschedul(?:e|ing)|after|before|pregnan(?:t|cy)|surgery|cancer|pain|location|address|where|how|why|when)\b)/iu.test(raw)) return false;
  return true;
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

// A campaign-specific Settings image is accepted only as a first-party
// public-config upload, never as a remote URL or a normal RM388 promo.
function configuredFirstReplyImage({ config, businessName, now = Date.now() } = {}) {
  if (!isNeutro(businessName) || campaignDay(now) === "expired") return null;
  const path = String(config?.adFirstReply?.rm68ImageUrl || "").trim();
  return /^\/promo-images\/[1-9][0-9]{0,9}$/u.test(path) ? path : null;
}

function localeFor(history, customerText, language) {
  return ["en","ms","zh"].includes(language) ? language :
    detectConversationLanguage([customerText, ...(Array.isArray(history) ? history.slice().reverse().filter(r=>r?.role==="user").map(r=>r.content) : [])], "zh");
}
function localizedDates(now, language) {
  const day=campaignDay(now);
  return language==="ms" ? (day==="dec6"?"6 Disember":"5 dan 6 Disember") :
    language==="en" ? (day==="dec6"?"December 6":"December 5 and 6") : dayLine(now);
}
function firstReply(now = Date.now(), language = "zh") {
  if (language==="en" || language==="ms") {
    const dates=localizedDates(now,language);
    if(campaignDay(now)==="expired") return language==="en"
      ? "Hello 💕 Welcome to Neutro Sense TCM! The December 5 and 6 event has ended. The clinic can confirm current breast-care options and appointments 😊"
      : "Hai 💕 Selamat datang ke Neutro Sense TCM! Acara 5 dan 6 Disember telah tamat. Pihak pusat boleh mengesahkan pilihan penjagaan payudara dan temu janji semasa 😊";
    return language==="en"
      ? "Hello 💕 Welcome to Neutro Sense TCM!\n\nOur limited-time breast wellness assessment + gentle pulse wave care offer 🌸\n✨ First trial: RM68 (regular price subject to clinic announcement)\n📅 Event dates: "+dates+"\n⏰ Breast care takes about 45 minutes; about 1 hour 30 minutes including complimentary moxibustion.\n✅ Breast wellness assessment, gentle pulse wave care and daily care advice.\n💗 Availability must be confirmed by the clinic. Would the event date(s) suit you? 😊"
      : "Hai 💕 Selamat datang ke Neutro Sense TCM!\n\nPromosi terhad penilaian kesejahteraan payudara + penjagaan gelombang denyutan lembut 🌸\n✨ Percubaan pertama: RM68 (harga biasa tertakluk pada pengumuman pusat)\n📅 Tarikh acara: "+dates+"\n⏰ Penjagaan payudara sekitar 45 minit; sekitar 1 jam 30 minit termasuk moksibusi percuma.\n✅ Penilaian kesejahteraan payudara, penjagaan gelombang denyutan lembut dan nasihat penjagaan harian.\n💗 Kekosongan perlu disahkan oleh pusat. Adakah tarikh acara sesuai untuk anda? 😊";
  }
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
    "⏰ RM68胸部护理约45分钟；加上赠送护理，全程约 1小时30分钟",
    "🎁 免费赠送艾灸护理",
    "",
    "护理包含：",
    "✅ 专业胸部健康评估",
    "✅ 脉冲波舒缓护理，帮助放松胸部周围组织",
    "✅ 胸部日常护理建议",
    "",
    "💗 具体名额需要由门店确认，建议提前预约哦！",
    "",
    dayQuestion(now),
  ].join("\n");
}
function isCampaignOpening(text) {
  const raw = String(text || "");
  return (raw.includes(INTRO_MARKER) && raw.includes("首次体验只需 RM68") &&
    raw.includes("全程约 1小时30分钟")) ||
    (raw.includes("Our limited-time breast wellness assessment + gentle pulse wave care offer") && raw.includes("First trial: RM68") && raw.includes("1 hour 30 minutes")) ||
    (raw.includes("Promosi terhad penilaian kesejahteraan payudara + penjagaan gelombang denyutan lembut") && raw.includes("Percubaan pertama: RM68") && raw.includes("1 jam 30 minit"));
}
function hasCampaignConversation(history) {
  const messages = Array.isArray(history) ? history : [];
  const first = messages.findIndex((row,index) => row?.role === "user" &&
    (isSimpleRm68Enquiry(row.content) || isRecoveryOfferChoice(messages.slice(0,index+1),row.content)));
  return first >= 0 && messages.slice(first + 1).some(
    row => row?.role === "assistant" && isCampaignOpening(row.content)
  );
}

const OTHER_TREATMENT = /(?:\b(?:3\s*d|9\s*d|hifu|facial|pelvic|postpartum)\b|骨盆|小颜|小顏|逆龄|逆齡|产后|產後|子宫|子宮|艾灸(?:疗程|療程|单做|單做|单独|單獨)|体态|體態|全身脉冲|全身脈衝)/iu;
const EXIT_CAMPAIGN = /(?:不想了解|不想要|换个|換個|另外想|改聊|停止|退订|退訂|取消活动|取消活動|\b(?:stop|unsubscribe|not interested|switch treatment|another service|cancel promotion)\b)/iu;
function isOtherTreatmentQuery(text) {
  return OTHER_TREATMENT.test(String(text || "")) || EXIT_CAMPAIGN.test(String(text || "")) ||
    /^(?:其他护理|脉冲波调理)$/u.test(normalize(text));
}
const CAMPAIGN_QUERY =
  /(?:只有这两天|只有這兩天|只有两天|只有兩天|就这两天|就這兩天|只有这两日|只有這兩日|胸部|乳腺|乳房|艾灸|赠送|贈送|脉冲|脈衝|专业检查|專業檢查|评估|評估|RM\s*68|RM\s*388|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|便宜|包括|包含|做什么|做什麼|什么项目|什麼項目|多久|多长|多長|时间|時間|小时|小時|日期|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:price|cost|fee|duration|how long|hours?|breast|pulse|rm ?68|rm ?388|appointment|availability|slot|december [56]|5th|6th)\b)/iu;
const AMOUNT_QUESTION =
  /(?:RM\s*(?:68|388)|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|\b(?:price|cost|fee|how much|harga)\b)/iu;
const DURATION_QUESTION =
  /(?:多久|多长|多長|时间|時間|小时|小時|\b(?:duration|how long|hour|hours|lama)\b)/iu;
const INCLUDES_QUESTION =
  /(?:包括|包含|赠送|贈送|艾灸|做什么|做什麼|什么项目|什麼項目|护理什么|護理什麼|\b(?:include|included|what do|consist)\b)/iu;
const DATE_QUESTION =
  /(?:只有这两天|只有這兩天|只有两天|只有兩天|就这两天|就這兩天|只有这两日|只有這兩日|日期|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:appointment|availability|slot|december [56]|5th|6th)\b)/iu;

function stillDiscussingCampaign(history) {
  const messages = Array.isArray(history) ? history : [];
  const opener = messages.findIndex(row => row?.role === "assistant" &&
    isCampaignOpening(row.content));
  return opener >= 0 && !messages.slice(opener + 1, -1).some(
    row => row?.role === "user" && isOtherTreatmentQuery(row.content)
  );
}
function isCampaignAvailabilityQuestion(text) {
  return DATE_QUESTION.test(String(text || ""));
}
// Detect an explicit request outside the event, not a request to confirm an event slot.
function alternativeDateRequest(text) {
  return /(?:\b(?:today|tomorrow|other (?:day|date)s?|another (?:day|date)|next week|not available|unavailable|cannot attend|can['’]t (?:come|attend|make it))\b|今天|明天|其他(?:日子|日期|时间)|改天|下周|下星期|不方便|没空|沒空|来不了|來不了|\b(?:hari ini|esok|hari lain|tarikh lain|minggu depan|tak (?:lapang|boleh)|tidak (?:lapang|boleh))\b)/iu.test(String(text||""));
}
function alternativeDateReply(language, now=Date.now()) {
  const expired=campaignDay(now)==="expired";
  const dates=localizedDates(now,language);
  if(language==="en") return (expired?"The RM68 event has ended.":"The RM68 promotion is only for "+dates+".")+
    " 😊 For another date, the clinic needs to confirm whether the assessment and care are available and what the applicable charges are.";
  if(language==="ms") return (expired?"Acara RM68 sudah tamat.":"Promosi RM68 hanya pada "+dates+".")+
    " 😊 Untuk tarikh lain, pihak pusat perlu mengesahkan ketersediaan penilaian dan penjagaan serta caj yang berkenaan.";
  return (expired?"RM68体验活动已经结束。":"RM68体验优惠仅限"+dates+"。")+
    " 😊 如果想安排其他日期，需要由门店确认是否能进行评估和护理，以及当天的收费哦。";
}
function campaignContextReply({ history, customerText, now = Date.now(), language } = {}) {
  if (!hasCampaignConversation(history) || !stillDiscussingCampaign(history) ||
      (!CAMPAIGN_QUERY.test(String(customerText || "")) && !alternativeDateRequest(customerText)) ||
      isOtherTreatmentQuery(customerText)) return null;
  const locale=localeFor(history,customerText,language);
  if (alternativeDateRequest(customerText)) return alternativeDateReply(locale,now);
  const priorUser=(Array.isArray(history)?history:[]).filter(r=>r?.role==="user" && String(r.content||"").trim()!==String(customerText||"").trim()).slice(-4);
  if (AMOUNT_QUESTION.test(String(customerText||"")) && priorUser.some(r=>alternativeDateRequest(r.content)))
    return alternativeDateReply(locale,now);
  if(locale!=="zh") {
    if(campaignDay(now)==="expired") return locale==="en"
      ? "The RM68 breast-care trial ended on December 6. The clinic can confirm current care options and charges 😊"
      : "Promosi penjagaan payudara RM68 telah tamat pada 6 Disember. Pihak pusat boleh mengesahkan pilihan penjagaan dan caj semasa 😊";
    const dates=localizedDates(now,locale);
    if(locale==="en") return "The RM68 breast wellness assessment and gentle pulse wave care event is on "+dates+", with complimentary moxibustion. Total duration is about 1 hour 30 minutes. It is not medical screening or diagnosis. Availability must be confirmed by the clinic 😊";
    return "Acara penilaian kesejahteraan payudara dan penjagaan gelombang denyutan lembut RM68 pada "+dates+", termasuk moksibusi percuma. Jumlah tempoh sekitar 1 jam 30 minit. Ini bukan saringan atau diagnosis perubatan. Kekosongan perlu disahkan oleh pusat 😊";
  }
  if (campaignDay(now) === "expired") {
    return "您之前咨询的 RM68 胸部护理体验活动已于12月6日结束。若想了解现在的护理安排，可以由门店帮您确认哦 😊";
  }
  const dates = dayLine(now);
  const text = String(customerText || "");
  // If the customer cannot attend the advertised dates and staff/AI has
  // offered ordinary care at a different time, an unscoped "how much?"
  // could refer to THAT care. Never quote the event RM68 as its price.
  if (AMOUNT_QUESTION.test(text) &&
      /^(?:(?:请问|請問|那么|那|想问|想問|请问一下)\s*)?(?:[价價][钱錢格]|价格|價格|多少钱|多少錢|收费|收費|费用|費用|how much|price|berapa harga)(?:呢|呀|啊|是)?[\s？?。!！]*$/iu.test(text)) {
    const prior = (Array.isArray(history) ? history : []).filter(
      item => item && item.role === "user" &&
        String(item.content || "").trim() !== text.trim()
    ).slice(-4).map(item => String(item.content || ""));
    const cannotAttend = prior.some(msg =>
      /(?:这两天|這兩天|那两天|那兩天|[56]\s*号|[56]\s*日).{0,35}(?:不在|不方便|没空|沒空|来不了|來不了|无法|無法|不行|can't|cannot)|(?:不在|不方便|没空|沒空|来不了|來不了|无法|無法|不行|can't|cannot).{0,35}(?:这两天|這兩天|那两天|那兩天|[56]\s*号|[56]\s*日)/iu.test(msg));
    const ordinaryCareOffered = (Array.isArray(history) ? history : []).slice(-6)
      .some(msg => msg?.role === "assistant" &&
        /(?:平日|平时|平時|其他日期|其他时间|其他時間|改天|平日.*护理|平日.*護理|\b(?:regular care|other days?|other dates?)\b)/iu.test(String(msg.content || "")));
    if (cannotAttend && ordinaryCareOffered) {
      return "RM68 是12月5日及6日的限时胸部护理体验优惠哦 😊 " +
        "如果你想安排其他日期，平日护理的收费需要先请门店确认，不能直接按 RM68 活动价计算。" +
        "请问你是想了解活动当天的 RM68 优惠，还是其他日期的护理收费呢？";
    }
  }
  if (DATE_QUESTION.test(text)) {
    // Never imply that a date, place, or appointment is confirmed.
    return "RM68 胸部健康评估 + 脉冲波舒缓护理的活动日期是" + dates +
      "，全程约1小时30分钟。具体名额需要由门店确认哦 😊 " + dayQuestion(now);
  }
  if (INCLUDES_QUESTION.test(text)) {
    return "RM68 首次体验包含专业胸部健康评估、脉冲波舒缓护理、胸部日常护理建议，并免费赠送艾灸护理；全程合计约1小时30分钟。" +
      "这项护理不等于医院的乳腺癌筛查或医学诊断 😊";
  }
  if (AMOUNT_QUESTION.test(text)) {
    return "您咨询的【胸部健康评估 + 脉冲波舒缓护理】12月活动首次体验是 RM68，免费赠送艾灸护理，合计全程约1小时30分钟。" +
      (/RM\s*388/iu.test(text)
        ? "RM388 属于另一项全身脉冲波护理优惠，两者不是同一个活动。"
        : "这是独立于其他脉冲波疗程的限时活动。") +
      "名额以门店确认为准 😊";
  }
  if (DURATION_QUESTION.test(text)) {
    return "这个 RM68 胸部健康评估 + 脉冲波舒缓护理活动，包含赠送的艾灸护理，全程合计约1小时30分钟，活动日期为" +
      dates + "。想预约可以先告诉我们方便的日期，由门店确认名额哦 😊";
  }
  return "您之前咨询的【胸部健康评估 + 脉冲波舒缓护理】首次体验 RM68，活动日期为" +
    dates + "，全程约1小时30分钟。名额需要由门店确认哦 😊";
}

// Keep a natural model answer only when it is compatible with the verified
// campaign and its current date window. Uncertain commercial or clinical
// claims fall back to localized verified copy, never a second AI call.
function selectCampaignReply({reply, fallback, history, customerText, language, now=Date.now()}={}) {
  if(!fallback) return reply;
  const value=String(reply||"").trim();
  const locale=localeFor(history,customerText,language);
  const prior=(Array.isArray(history)?history:[]).filter(r=>r?.role==="user").slice(-5);
  if(!value || alternativeDateRequest(customerText) ||
      (AMOUNT_QUESTION.test(String(customerText||"")) && prior.some(r=>alternativeDateRequest(r.content)))) return fallback;
  if(campaignDay(now)==="expired" || campaignDay(now)==="dec6") return fallback;
  const {clearReplyLanguageMismatch}=require("./replyLanguageGuard");
  if(clearReplyLanguageMismatch(value,locale)) return fallback;
  // An arbitrary number, unsupported diagnostic statement, or confirmation
  // is not authorized merely because Gemini mentioned RM68.
  if(/\b(?:ultrasound|mammogram|mammography|screening|diagnos\w*|cure|guarantee|confirmed|booked|available today|available tomorrow)\b|超声|超音波|筛查|篩查|诊断|診斷|治愈|保证|已确认|已預約|已预约|\b(?:ultrabunyi|saringan|diagnosis|disahkan|dijamin)\b/iu.test(value)) return fallback;
  if(/\b(?:RM|MYR)\s*(?!68\b)\d/iu.test(value) ||
      /\b(?:2\s*(?:hours?|jam)\s*15|2h\s*15)\b|2\s*(?:小时|小時)\s*15/iu.test(value)) return fallback;
  if(AMOUNT_QUESTION.test(String(customerText||"")) && !/\bRM\s*68\b/iu.test(value)) return fallback;
  if(DATE_QUESTION.test(String(customerText||"")) &&
     (!/(?:December|Dec\b|Disember|12月)/iu.test(value) ||
      !/(?:check|confirm|semak|sahkan|确认|確認)/iu.test(value))) return fallback;
  if(DURATION_QUESTION.test(String(customerText||"")) &&
     !/(?:90\s*(?:minutes|minit|分钟|分鐘)|1\s*(?:hour|jam|小时|小時)\s*30|1\.5\s*(?:hours?|jam|小时|小時))/iu.test(value)) return fallback;
  // Avoid a generic reply that has lost the event context.
  if(!/(?:RM\s*68|breast|payudara|胸部|乳腺|乳房|December|Disember|12月|moxibustion|moksibusi|艾灸)/iu.test(value)) return fallback;
  return value;
}
function guardCampaignPriceConflicts({ history, customerText, reply, now = Date.now(), language } = {}) {
  const original = String(reply || "");
  if (!hasCampaignConversation(history) || !stillDiscussingCampaign(history) ||
      isOtherTreatmentQuery(customerText)) return original;
  if (/(?:RM\s*(?:388|688)|2\s*(?:小时|小時|hours?)\s*15|2h\s*15)/iu.test(original) ||
      (campaignDay(now) === "expired" && /\bRM\s*68\b/iu.test(original)) ||
      (campaignDay(now) === "dec6" && /12月5日/u.test(original))) {
    const query = CAMPAIGN_QUERY.test(String(customerText || ""))
      ? customerText
      : campaignDay(now) === "dec6" && /12月5日/u.test(original)
        ? "活动日期" : "RM68优惠";
    return campaignContextReply({ history, customerText: query, now, language }) || original;
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
  // Do not keep selling the same dates when the customer has rejected them.
  if (alternativeDateRequest(latest)) return { expired: false, message: alternativeDateReply(detectConversationLanguage(candidate.recent_inbound_messages || [], "zh"),now) };
  const locale=localeFor([], null, detectConversationLanguage(candidate.recent_inbound_messages || [], "zh"));
  const dates=localizedDates(now,locale);
  if(locale==="en" || locale==="ms") return {expired:false,message:locale==="en" ? "Hi 💕 A friendly reminder: the RM68 breast wellness assessment and gentle pulse wave care event is on "+dates+", with complimentary moxibustion (about 1 hour 30 minutes in total). Availability must be confirmed by the clinic 😊" : "Hai 💕 Peringatan mesra: acara penilaian kesejahteraan payudara dan penjagaan gelombang denyutan lembut RM68 pada "+dates+", termasuk moksibusi percuma (sekitar 1 jam 30 minit). Kekosongan perlu disahkan oleh pusat 😊"};
  const message = day === "both"
    ? "您好💕 温馨提醒：您之前了解的【胸部健康评估 + 脉冲波舒缓护理】首次体验 RM68，额外免费赠送艾灸护理，活动日期为12月5日和6日，全程约1小时30分钟（含赠送护理）。具体名额以门店确认为准，如需安排欢迎回复我们 😊"
    : "您好💕 温馨提醒：您之前了解的【胸部健康评估 + 脉冲波舒缓护理】RM68 活动只剩今天12月6日，额外免费赠送艾灸护理，全程约1小时30分钟（含赠送护理）。具体名额以门店确认为准，如需安排欢迎回复我们 😊";
  return { expired: false, message };
}

// A generic breast-care selection is not explicit event interest. Invite a
// choice, and only use the dated event intro after a readable explicit enquiry.
const RECOVERY_BREAST_INVITE_PREFIX = "您好 😊 我们有提供胸部健康评估和舒缓护理，目前12月活动也有 RM68 首次体验优惠";
function recoveryBreastOfferInvitation({customerText,config,now=Date.now()}={}) {
  if (!isNeutro(config?.businessName||config?.clinicName) || config?.adFirstReply?.enabled!==true ||
      campaignDay(now)==="expired" || normalize(customerText)!=="胸部护理") return null;
  return RECOVERY_BREAST_INVITE_PREFIX+"（"+dayLine(now)+"）。请问您想了解这个限时活动，还是平日的胸部护理呢？";
}
function isRecoveryOfferChoice(history,customerText) {
  const prior=(Array.isArray(history)?history:[]).slice(0,-1);
  const previousUser=prior.findLast(row=>row?.role==="user");
  const previousAssistant=prior.at(-1);
  return normalize(previousUser?.content)==="胸部护理" &&
    previousAssistant?.role==="assistant" &&
    String(previousAssistant.content||"").startsWith(RECOVERY_BREAST_INVITE_PREFIX) &&
    /^(?:RM\s*68|(?:我)?(?:想|要|想要)(?:了解)?(?:这个|这项|限时)?活动|这个活动|限时活动|活动优惠|RM\s*68\s*(?:活动|优惠|体验))(?:[。！!😊\s]*)$/iu.test(normalize(customerText));
}
function recoveryBreastCampaignOpening({history,customerText,config,now=Date.now(),language}={}) {
  if (!isNeutro(config?.businessName||config?.clinicName) || config?.adFirstReply?.enabled!==true ||
      campaignDay(now)==="expired" || (!isSimpleRm68Enquiry(customerText) && !isRecoveryOfferChoice(history,customerText)) ||
      hasCampaignConversation(history)) return null;
  const latestPrior=(Array.isArray(history)?history:[]).slice(0,-1).reverse().find(row=>row?.role==="user");
  if (normalize(latestPrior?.content)!=="胸部护理") return null;
  return {reply:firstReply(now,localeFor(history,customerText,language)),treatment:null,serviceQuery:false,serviceQuerySource:null,campaignKey:CAMPAIGN_KEY};
}

module.exports = {
  CAMPAIGN_KEY, PREFILL, FOLLOWUP_PREFILL, INTRO_MARKER, MYT_CAMPAIGN_END,
  isNeutro, isExactPrefill, isSimpleRm68Enquiry, campaignCreativeMatches, campaignDay,
  firstReply, configuredFirstReplyImage, isCampaignOpening, hasCampaignConversation,
  isOtherTreatmentQuery, stillDiscussingCampaign, isCampaignAvailabilityQuestion,
  campaignContextReply, guardCampaignPriceConflicts, alternativeDateRequest, alternativeDateReply, selectCampaignReply,
  candidateIsCampaign, campaignFollowUp, recoveryBreastOfferInvitation, recoveryBreastCampaignOpening,
};
