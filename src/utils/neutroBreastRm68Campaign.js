"use strict";
const { detectConversationLanguage } = require("./chatLanguage");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { detectDate, localParts } = require("./appointmentHoursGuard");
const { rm68CampaignSettings } = require("../config/neutroRm68CampaignConfig");
const {normalizeMoneyText,scanMyrAmounts,hasMyrAmount}=require("./myrAmountClaims");
const defaultCampaign = require("../config/neutroRm68Campaign.default.json");
const {campaignDatesInText}=require("./neutroRm68DateEvidence");
const {standaloneLocationQuestion,confirmedSingleBranchLocationAnswer,verifyLocationDraft,standaloneBusinessHoursQuestion,confirmedBusinessHoursAnswer,verifyBusinessHoursDraft}=require("./verifiedPricingBusinessFacts");

// Dedicated event package, intentionally separate from the standing RM388
// full-body Pulse Wave offer. Nothing here changes configured service prices.
const CAMPAIGN_KEY = defaultCampaign.campaignKey;
const PREFILL = "你好！我想了解【胸部专业检查 RM68体验优惠】，请问还有名额吗？";
// Keep the legacy Meta ad live while the copy is gradually updated.
// This is only campaign recognition; promotional consent is verified separately.
const FOLLOWUP_PREFILL = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】有兴趣，请问还有名额吗？可以跟进我，有优惠也发我看看 😊";
const MYT_CAMPAIGN_END = Date.parse(defaultCampaign.expiresAt);
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
  const {valid,campaign}=rm68CampaignSettings();
  if (!valid || !Number.isFinite(time)) return "expired";
  if (time >= Date.parse(campaign.expiresAt)) return "expired";
  if (time >= Date.parse(campaign.lastDayStartsAt)) return "dec6";
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
function firstReply(now = Date.now(), language = "zh") {
  const locale=["zh","en","ms"].includes(language)?language:"zh";
  const {valid,campaign}=rm68CampaignSettings();
  if(!valid || (campaignDay(now)==="expired" && Number(now)<MYT_CAMPAIGN_END)) return locale==="en"
    ? "Hello 😊 The clinic needs to confirm the current breast-care offer and appointment details."
    : locale==="ms"
      ? "Hai 😊 Pihak pusat perlu mengesahkan tawaran penjagaan payudara dan butiran temu janji semasa."
      : "您好 😊 目前的胸部护理优惠及预约安排需要由门店确认哦。";
  return campaign.firstReply[campaignDay(now)][locale];
}
function isCampaignOpening(text) {
  const raw = String(text || "");
  const {valid,campaign}=rm68CampaignSettings();
  // Retain legacy recognition for already delivered campaign conversations.
  if(valid && ["both","dec6"].some(day=>
    Object.values(campaign.firstReply[day]).some(copy=>normalize(copy)===normalize(raw))))return true;
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
  const value=normalize(text);
  return OTHER_TREATMENT.test(value) || EXIT_CAMPAIGN.test(value) ||
    /^(?:其他护理|脉冲波调理|脉冲波|pulse wave(?: treatment)?|rawatan pulse wave|gelombang denyutan)[\s.!！。?？]*$/iu.test(value) ||
    /(?:全身(?:的)?(?:脉冲波|脈衝波)|\b(?:full[\s-]*body|body contouring|slimming)\b.{0,30}\b(?:pulse wave|treatment|care)\b|\b(?:pulse wave|rawatan)\b.{0,30}\b(?:full[\s-]*body|seluruh badan|pelangsingan)\b)/iu.test(value);
}
const CAMPAIGN_QUERY =
  /(?:只有这两天|只有這兩天|只有两天|只有兩天|就这两天|就這兩天|只有这两日|只有這兩日|胸部|乳腺|乳房|艾灸|赠送|贈送|脉冲|脈衝|专业检查|專業檢查|评估|評估|RM\s*68|RM\s*388|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|便宜|包括|包含|做什么|做什麼|什么项目|什麼項目|多久|多长|多長|时间|時間|小时|小時|日期|哪天|哪一天|哪日|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:price|cost|fee|duration|how long|hours?|breast|pulse|rm ?68|rm ?388|appointment|availability|slot|december [56]|5th|6th)\b)/iu;
const AMOUNT_QUESTION =
  /(?:RM\s*(?:68|388)|多少[钱錢]|[价價][钱錢格]|收费|收費|費用|费用|\b(?:price|cost|fee|how much|harga)\b)/iu;
const DURATION_QUESTION =
  /(?:多久|多长|多長|时间|時間|小时|小時|\b(?:duration|how long|hour|hours|lama)\b)/iu;
const INCLUDES_QUESTION =
  /(?:包括|包含|赠送|贈送|艾灸|做什么|做什麼|什么项目|什麼項目|护理什么|護理什麼|\b(?:include|included|what do|consist|termasuk|merangkumi|apa yang termasuk)\b)/iu;
const DATE_QUESTION =
  /(?:只有这两天|只有這兩天|只有两天|只有兩天|就这两天|就這兩天|只有这两日|只有這兩日|日期|哪天|哪一天|哪日|几号|幾號|[56]\s*[号日]|星期[六日]|礼拜[六日]|禮拜[六日]|名额|名額|有位|空位|预约|預約|安排|还有吗|還有嗎|还有没有|還有沒有|\b(?:appointment|availability|slot|december [56]|5th|6th)\b)/iu;

function priorCampaignTurns(history, customerText) {
  const messages=Array.isArray(history)?history:[];
  const last=messages.at(-1);
  return last?.role==="user" && normalize(last.content)===normalize(customerText)
    ? messages.slice(0,-1):messages;
}
function stillDiscussingCampaign(history, customerText) {
  const messages=customerText===undefined
    ? (Array.isArray(history)?history:[]).slice(0,-1)
    : priorCampaignTurns(history,customerText);
  const opener=messages.findLastIndex(row=>row?.role==="assistant" && isCampaignOpening(row.content));
  return opener>=0 && !messages.slice(opener+1).some(row=>row?.role==="user" && isOtherTreatmentQuery(row.content));
}
// Campaign history supplies context for a complete short location question,
// never a symptom location, treatment duration, or mixed booking/price request.
function campaignAdministrativeKind(text){
  if(standaloneLocationQuestion(text,true))return "location";
  if(standaloneBusinessHoursQuestion(text))return "hours";
  return null;
}
function activeCampaignThread(history, customerText) {
  return hasCampaignConversation(history) && stillDiscussingCampaign(history,customerText) &&
    !isOtherTreatmentQuery(customerText);
}
// Use the clinic's date parser for calendar semantics, and require scheduling
// evidence before interpreting relative words as requests to book.
const SCREENING=/(?:超声|超聲|超音波|乳房筛查|乳房篩查|乳腺筛查|乳腺篩查|\b(?:ultrasound|sonogram|mammogram|mammography|screening|ultrabunyi|saringan)\b)/iu;
const VISIT_ACTION=/(?:\b(?:come|visit|book|appointment|slot|schedule|reschedule|available|availability|attend|make it|do the treatment|do the checking|have (?:the |a )?(?:treatment|assessment|session))\b|预约|預約|安排|名额|名額|空位|有位|过来|過來|来做|來做|来店|來店|到店|上来|上來|可以来|可以來|\b(?:datang|tempah|temu janji|kekosongan|buat rawatan|buat pemeriksaan|lapang)\b)/iu;
const RESULT_TIMING=/(?:\b(?:results?|effectiveness|effective|side effects?|pain|swelling|recovery|heal|improvement)\b|见效|見效|效果|消肿|消腫|副作用|疼痛|恢复|恢復|\b(?:kesan|berkesan|sakit|pulih)\b)/iu;
const EVENT_REJECTION=/(?:\b(?:cannot attend|can['’]t (?:come|attend|make it)|not available|unavailable|not free|away)\b|不方便|没空|沒空|来不了|來不了|不在|无法|無法|\b(?:tak (?:lapang|boleh)|tidak (?:lapang|boleh))\b)/iu;
const EVENT_REFERENCE=/(?:December|Dec\b|5th|6th|event|12月|[56]\s*[号日]|这两天|這兩天|那两天|那兩天|活动|活動|Disember|acara|tarikh)/iu;
const OTHER_DATE=/(?:\b(?:other (?:day|date)s?|another (?:day|date)|next week)\b|其他(?:日子|日期|时间|時間)|改天|下周|下星期|\b(?:hari lain|tarikh lain|minggu depan)\b)/iu;
const TODAY=/(?:\btoday\b|今天|\bhari ini\b)/iu;
const TOMORROW=/(?:\btomorrow\b|明天|\besok\b)/iu;
function eventDateRejection(text) {
  const value=String(text||"");
  return EVENT_REJECTION.test(value) && EVENT_REFERENCE.test(value) && !RESULT_TIMING.test(value);
}
function schedulingQuestion(text) {
  const value=String(text||"");
  if(RESULT_TIMING.test(value) && !VISIT_ACTION.test(value)) return false;
  return DATE_QUESTION.test(value) || eventDateRejection(value) ||
    (VISIT_ACTION.test(value) && (TODAY.test(value)||TOMORROW.test(value)||OTHER_DATE.test(value)||
       /\b(?:temu janji|kekosongan|tarikh|Disember)\b/iu.test(value)));
}
function configuredEventDateMatches(date,day="both"){
  const {campaign}=rm68CampaignSettings();
  const dates=day==="dec6"?campaign.eventDates.slice(-1):campaign.eventDates;
  return dates.some(iso=>Number(iso.slice(5,7))===date.month&&Number(iso.slice(8,10))===date.day);
}
function alternativeDateRequest(text, now=Date.now()) {
  const value=String(text||"");
  if(eventDateRejection(value)) return true;
  if(!VISIT_ACTION.test(value) || RESULT_TIMING.test(value)) return false;
  if(OTHER_DATE.test(value)) return true;
  // Explicit December dates outside the advertised days.
  const dates=campaignDatesInText(value);
  if(dates.some(d=>!configuredEventDateMatches(d))) return true;
  const at=now===null?NaN:Number(now);
  if(!Number.isFinite(at)) return false;
  const day=new Date(at+8*3600000).toISOString().slice(0,10);
  const tomorrow=new Date(at+32*3600000).toISOString().slice(0,10);
  const eventDates=rm68CampaignSettings().campaign.eventDates;
  return (!eventDates.includes(day)&&TODAY.test(value))||
    (!eventDates.includes(tomorrow)&&TOMORROW.test(value));
}
function historicalTime(row) {
  const raw=row?.pricingCreatedAtMs ?? row?.created_at ?? row?.createdAt;
  if(raw==null)return null;
  const at=typeof raw==="number"?raw:Date.parse(raw);
  return Number.isFinite(at)?at:null;
}
function dateScope(text,now) {
  const value=String(text||"");
  if(SCREENING.test(value)||RESULT_TIMING.test(value)&&!VISIT_ACTION.test(value))return null;
  if(eventDateRejection(value)||alternativeDateRequest(value,now))return "ordinary";
  if(!VISIT_ACTION.test(value)&&!DATE_QUESTION.test(value)&&!/(?:[56]\s*日(?:方便|可以)|\b(?:5th|6th|both days|those days)\b)/iu.test(value))return null;
  const dates=campaignDatesInText(value);
  if(dates.length) return dates.every(d=>configuredEventDateMatches(d))?"event":"ordinary";
  const at=now===null?NaN:Number(now);
  const local=Number.isFinite(at)?localParts(at):null;
  const date=local&&detectDate(value,local.date);
  if(date?.date)return rm68CampaignSettings().campaign.eventDates.includes(date.date)?"event":"ordinary";
  if(/(?:这两天|這兩天|那两天|那兩天|[56]\s*[号日]|\b(?:both days|those days|5th|6th)\b)/iu.test(value))return "event";
  return null;
}
function campaignDateScope(history,customerText,now=Date.now()) {
  const current=dateScope(customerText,now);
  if(current)return current;
  const previous=priorCampaignTurns(history,customerText);
  const opener=previous.findLastIndex(t=>t?.role==="assistant"&&isCampaignOpening(t.content));
  for(let i=previous.length-1;i>opener;i--){
    const t=previous[i];
    if(t?.role!=="user")continue;
    const scope=dateScope(t.content,historicalTime(t));
    if(scope)return scope;
  }
  return null;
}
function alternativeDateContext(history,customerText,now=Date.now()){
  return campaignDateScope(history,customerText,now)==="ordinary";
}
function campaignAmountRequested(text) {
  const value=String(text||"");
  // A customer's reference to the exact advertised amount is not a new
  // quote request unless they actually ask whether that amount applies.
  return hasExplicitPriceRequest(value) ||
    ((hasMyrAmount(value,68)||hasMyrAmount(value,388)) &&
      /(?:吗|嗎|是不是|是否|\b(?:is it|is this|still|betul)\b)/iu.test(value));
}
function isCampaignAvailabilityQuestion(text) {
  return !SCREENING.test(String(text||"")) && (schedulingQuestion(text)||Boolean(dateScope(text,Date.now())));
}
function campaignLanguage(history,text) {
  const value=String(text||"");
  // A short capability question may have no general-language tokens.
  // Only use these unmistakable terms when there is no Chinese sentence.
  if(!/[\u3400-\u9fff]/u.test(value)) {
    if(/\b(?:ultrabunyi|saringan)\b/iu.test(value)) return "ms";
    if(/\b(?:ultrasound|sonogram|mammogram|mammography|screening)\b/iu.test(value)) return "en";
  }
  return detectConversationLanguage([value,...(Array.isArray(history)?history:[])
    .filter(t=>t?.role==="user").map(t=>t.content).reverse()],"zh");
}
function localized(language,zh,en,ms) {
  return language==="en"?en:language==="ms"?ms:zh;
}
function screeningAcknowledgement({history,customerText,language:requestedLanguage}={}) {
  const text=String(customerText||"");
  if(!activeCampaignThread(history,text) || !SCREENING.test(text) || hasClinicalMediaRisk(text)) return null;
  const language=localeFor(history,text,requestedLanguage || campaignLanguage(history,text));
  return localized(language,
    "这项护理评估并不等同于医学筛查。我们暂时无法确认门店是否提供超声波或其他医学筛查，需要请工作人员核实。😊",
    "The wellness assessment is not a medical screening. I can’t confirm whether ultrasound or other medical screening is available; our staff will need to check. 😊",
    "Penilaian penjagaan ini bukan saringan perubatan. Saya belum boleh mengesahkan sama ada ultrabunyi atau saringan perubatan lain tersedia; staf perlu menyemaknya. 😊");
}
function campaignContextReply({ history, customerText, now = Date.now(), language:requestedLanguage } = {}) {
  const text=String(customerText||"");
  if (!activeCampaignThread(history,text) || hasClinicalMediaRisk(text) || campaignAdministrativeKind(text)) return null;
  const language=localeFor(history,text,requestedLanguage || campaignLanguage(history,text));
  const day=campaignDay(now);
  const askedAmount=campaignAmountRequested(text);
  const screening=screeningAcknowledgement({history,customerText:text,language});
  const previous=priorCampaignTurns(history,text);
  if(RESULT_TIMING.test(text)&&!isCampaignAvailabilityQuestion(text)&&!askedAmount&&!screening)return null;
  const today=/(?:今天|\btoday\b|\bhari ini\b)/iu.test(text);
  const currentScope=dateScope(text,now);
  const ordinary=campaignDateScope(history,text,now)==="ordinary";
  const explicitEventPrice=hasMyrAmount(text,rm68CampaignSettings().campaign.priceMYR) && askedAmount && currentScope!=="ordinary";
  if (currentScope==="ordinary" || (ordinary && !explicitEventPrice &&
      (askedAmount || isCampaignAvailabilityQuestion(text)))) {
    const priorScreening=previous.at(-1)?.role==="user" && SCREENING.test(String(previous.at(-1).content||""));
    const base=localized(language,
      "明白😊 其他日期是否可以安排胸部评估及护理，需要由门店确认。"+(askedAmount?"其他日期的护理收费需要先请门店确认。":""),
      "Understood 😊 The clinic will need to confirm whether the breast assessment and care can be arranged "+(today?"today.":"on your requested date.")+(askedAmount?" The regular-care price also needs to be confirmed separately.":""),
      "Faham 😊 Pusat perlu mengesahkan sama ada penilaian dan penjagaan payudara boleh diatur pada tarikh yang anda minta."+(askedAmount?" Harga penjagaan biasa juga perlu disahkan berasingan.":""));
    return base+(screening||priorScreening?" "+(screening||screeningAcknowledgement({history,customerText:previous.at(-1).content})||""):"");
  }
  if (screening) return screening;
  if (!CAMPAIGN_QUERY.test(text) && !askedAmount && !currentScope && !INCLUDES_QUESTION.test(text) && !DURATION_QUESTION.test(text)) return null;
  if (day === "expired") {
    const {valid,campaign}=rm68CampaignSettings();
    // An operator may stop the offer early; do not claim its scheduled
    // final day has already occurred. Invalid settings also fail closed.
    if(!valid || Number(now)<MYT_CAMPAIGN_END)return localized(language,
      "您之前咨询的胸部护理体验活动目前已不再开放。若想了解现在的护理安排，可以由门店帮您确认哦 😊",
      "The breast-care event is no longer available. Our staff can confirm current care arrangements"+(askedAmount?" and prices":"")+". 😊",
      "Acara penjagaan payudara tidak lagi tersedia. Staf boleh mengesahkan aturan penjagaan semasa"+(askedAmount?" dan harga":"")+". 😊");
    const last=new Date(campaign.eventDates.at(-1)+"T00:00:00Z");
    const zhDate=(last.getUTCMonth()+1)+"月"+last.getUTCDate()+"日";
    const enDate=new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"long",timeZone:"UTC"}).format(last);
    const msDate=new Intl.DateTimeFormat("ms-MY",{day:"numeric",month:"long",timeZone:"UTC"}).format(last);
    return localized(language,
      "您之前咨询的"+(askedAmount?" RM"+campaign.priceMYR+" ":"")+"胸部护理体验活动已于"+zhDate+"结束。若想了解现在的护理安排，可以由门店帮您确认哦 😊",
      "The breast-care event ended on "+enDate+". Our staff can confirm current care arrangements"+(askedAmount?" and prices":"")+". 😊",
      "Acara penjagaan payudara telah tamat pada "+msDate+". Staf boleh mengesahkan aturan penjagaan semasa"+(askedAmount?" dan harga":"")+". 😊");
  }
  const dates=dayLine(now);
  const enDates=day==="dec6"?"6 December":"5 and 6 December";
  const msDates=day==="dec6"?"6 Disember":"5 dan 6 Disember";
  if (DATE_QUESTION.test(text) || currentScope==="event") {
    // A date-only question must not disclose a price. Keep the availability
    // caveat and only offer dates still valid in Malaysia.
    return localized(language,
      (askedAmount?"RM68 ":"")+"胸部健康评估 + 脉冲波舒缓护理的活动日期是"+dates+"，全程约1小时30分钟。具体名额需要由门店确认哦 😊 "+dayQuestion(now),
      "The breast assessment and pulse-wave care event is on "+enDates+". The full visit takes about 90 minutes."+(askedAmount?" The event price is RM68.":"")+" Availability is subject to clinic confirmation. 😊",
      "Acara penilaian payudara dan penjagaan gelombang nadi pada "+msDates+". Tempoh keseluruhan kira-kira 90 minit."+(askedAmount?" Harga acara RM68.":"")+" Slot tertakluk pada pengesahan pusat. 😊");
  }
  if (INCLUDES_QUESTION.test(text)) {
    return localized(language,
      (askedAmount?"RM68 ":"")+"首次体验包含专业胸部健康评估、脉冲波舒缓护理、胸部日常护理建议，并免费赠送艾灸护理；全程合计约1小时30分钟。这项护理不等于医院的乳腺癌筛查或医学诊断 😊",
      (askedAmount?"The RM68 trial":"The trial")+" includes a breast wellness assessment, pulse-wave care, general care advice and complimentary moxibustion, about 90 minutes in total. It is not medical screening or diagnosis. 😊",
      (askedAmount?"Percubaan RM68":"Percubaan")+" termasuk penilaian penjagaan payudara, penjagaan gelombang nadi, nasihat penjagaan am dan moksibusi percuma, kira-kira 90 minit. Ini bukan saringan atau diagnosis perubatan. 😊");
  }
  if (askedAmount) {
    const compare=hasMyrAmount(text,388);
    return localized(language,
      "您咨询的【胸部健康评估 + 脉冲波舒缓护理】"+dates+" 活动首次体验是 RM68，免费赠送艾灸护理，合计全程约1小时30分钟。"+(compare?"RM388 属于另一项全身脉冲波护理优惠，两者不是同一个活动。":"这是独立于其他脉冲波疗程的限时活动。")+"名额以门店确认为准 😊",
      "The breast assessment and pulse-wave care trial on "+enDates+" is RM68, with complimentary moxibustion, about 90 minutes in total."+(compare?" RM388 is a separate full-body Pulse Wave offer.":"")+" Availability is subject to clinic confirmation. 😊",
      "Harga percubaan penilaian payudara dan penjagaan gelombang nadi pada "+msDates+" ialah RM68, termasuk moksibusi percuma, kira-kira 90 minit."+(compare?" RM388 ialah tawaran gelombang nadi seluruh badan yang berasingan.":"")+" Slot tertakluk pada pengesahan pusat. 😊");
  }
  if (DURATION_QUESTION.test(text)) {
    return localized(language,
      "这个胸部健康评估 + 脉冲波舒缓护理活动，包含赠送的艾灸护理，全程合计约1小时30分钟。😊",
      "Breast care takes about 45 minutes, or about 90 minutes in total including the complimentary moxibustion care. 😊",
      "Penjagaan payudara sekitar 45 minit, atau kira-kira 90 minit keseluruhan, termasuk moksibusi percuma. 😊");
  }
  // An ordinary treatment question is for Gemini, not a generic sales pitch.
  return null;
}

// Extract dates by meaning rather than allowing individual numeric tokens.
// Cover common written and numeric dates in all three supported languages.

// Duration must describe the right part of the visit. A generic event
// duration is the total; 45 minutes is only the breast-care component.
// Keep scope local to each claim, including a trailing "in total" qualifier.
function campaignDurationClaims(value){
  const text=String(value||"");
  const claims=[...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h(?=\s*\d|\b)|jam|小时|小時)(?:\s*(?:and\s+|dan\s+|又\s*)?(\d{1,2})(?!\d)\s*(?:minutes?|mins?|minit|m\b|分钟|分鐘)?)?|(\d+(?:\.\d+)?)\s*(minutes?|mins?|minit|分钟|分鐘)/giu)];
  const total=/(?:\b(?:full\s+(?:visit|session|appointment|treatment)|total(?:\s+(?:visit|duration|time|session))?|whole\s+(?:visit|session)|including\s+(?:the\s+)?(?:complimentary\s+)?moxibustion|keseluruhan|termasuk\s+(?:rawatan\s+)?moksibusi)\b|全程|总时长|總時長|总共|總共|合计|合計|整体|整體|包含(?:赠送|贈送)?艾灸|加上(?:赠送|贈送)?艾灸)/iu;
  const care=/(?:\b(?:breast(?:\s+wellness)?\s+(?:care|treatment|assessment)|penjagaan\s+payudara|rawatan\s+payudara)\b|胸部(?:护理|護理|评估|評估)|乳房(?:护理|護理)|乳腺(?:护理|護理))/iu;
  const trailingTotal=/^[\s,，]*(?:(?:in\s+total|keseluruhan)\b|合计|合計|全程|总共|總共|(?:including\s+(?:the\s+)?(?:complimentary\s+)?moxibustion)\b|包含(?:赠送|贈送)?艾灸)/iu;
  return claims.map((m,i)=>{
    const minutes=m[1]===undefined?Number(m[4]):Number(m[1])*60+Number(m[3]||0);
    const prefix=text.slice(i?claims[i-1].index+claims[i-1][0].length:0,m.index);
    const clause=prefix.split(/[;；。！？!?，,\n]|\.(?!\d)|\b(?:or|and|atau|dan)\b|或者|以及/iu).at(-1);
    const suffix=text.slice(m.index+m[0].length,claims[i+1]?.index??text.length);
    // A comma followed by a total-scope label and another duration starts
    // a new claim, rather than retroactively qualifying the care duration.
    const nextTotalClause=Boolean(claims[i+1])&&
      /^[\s,，]*(?:(?:keseluruhan)\b|全程|总时长|總時長|总共|總共|合计|合計|整体|整體)[\s]*(?:(?:约|約|大约|大約|为|為|是|kira-kira|sekitar|ialah|adalah)\s*)*$/iu.test(suffix);
    const totalScope=total.test(clause)||(!nextTotalClause&&trailingTotal.test(suffix));
    const careScope=care.test(clause);
    return {minutes,scope:!totalScope&&careScope?"care":"total",valid:m[3]===undefined||(Number(m[3])<60&&!m[1].includes("."))};
  });
}
function campaignDurationsSafe(value,campaign){
  return campaignDurationClaims(value).every(claim=>claim.valid&&claim.minutes===(claim.scope==="care"?campaign.careMinutes:campaign.totalMinutes));
}

function campaignClaimsSafe(value, now=Date.now()) {
  const text=normalizeMoneyText(value);
  const day=campaignDay(now);
  const amounts=scanMyrAmounts(text).map(claim=>claim.amount);
  const {campaign}=rm68CampaignSettings();
  if(amounts.some(n=>n!==campaign.priceMYR)|| (day==="expired"&&amounts.length))return false;
  const dates=campaignDatesInText(text);
  if(dates.some(d=>!configuredEventDateMatches(d,day)))return false;
  const allowedYears=new Set(campaign.eventDates.map(date=>date.slice(0,4)));
  if([...text.matchAll(/\b20\d{2}\b/gu)].some(m=>!allowedYears.has(m[0])))return false;
  // A qualified availability statement is not a booking confirmation.
  // Remove only complete, narrowly defined caveats before evaluating risky
  // claims. Do not remove adjacent promises or actual confirmation language.
  const riskyText=text.replace(/(?:\b(?:availability|slots?) (?:must be|needs? to be|will need to be|still needs? to be) confirmed by (?:the |our )?(?:clinic|centre|center)\b|\b(?:kekosongan|slot) perlu disahkan oleh (?:pihak )?pusat\b|具体名额(?:仍)?(?:需要|需|必须)由门店确认|具體名額(?:仍)?(?:需要|需|必須)由門店確認)/giu," ");
  // Unverified slot, clinical equipment, guarantees and unrelated prices
  // cannot be authorised by a fluent answer.
  if(/\b(?:ultrasound|mammogram|mammography|screening|diagnos\w*|cure|guarantee|confirmed|booked|available today|available tomorrow|slots? (?:are|is) available|(?:we have|there are) (?:a |any )?(?:slots?|availability))\b|超声|超音波|筛查|篩查|诊断|診斷|治愈|保证|已确认|已預約|已预约|还有空位|\b(?:ultrabunyi|saringan|diagnosis|disahkan|dijamin|slot tersedia|ada kekosongan)\b/iu.test(riskyText))return false;
  if(amounts.length && (!dates.length||/\b(?:any day|any date|every day|daily|all dates|other dates? (?:at|for) RM|regular price|outside (?:the )?event|also (?:available|valid)|anytime|today|tomorrow)\b|每天|任何日期|平日.{0,12}RM\s*68|其他日期.{0,12}RM\s*68|\b(?:setiap hari|bila-bila masa|hari ini|esok)\b/iu.test(text)))return false;
  if(!campaignDurationsSafe(text,campaign))return false;
  // Prices must be explicitly event-scoped, not just coexist with a valid date.
  if(amounts.length && !/(?:\bevent\b|\bpromotion\b|\btrial\b|\bonly\b|\bpromo\b|活动|活動|体验|體驗|限时|限時|优惠|優惠|\bacara\b|\bpromosi\b|\bpercubaan\b)/iu.test(text))return false;
  return true;
}
function guardCampaignPriceConflicts({ history, customerText, reply, now = Date.now(), language } = {}) {
  const original=String(reply||"");
  const text=String(customerText||"");
  if(!activeCampaignThread(history,text))return original;
  // Administrative facts have their own verified source; do not interpret
  // an address, postcode or opening hours as event dates/durations.
  if(campaignAdministrativeKind(text)&&!scanMyrAmounts(original).length)return original;
  const day=campaignDay(now);
  const ordinary=campaignDateScope(history,text,now)==="ordinary";
  const amounts=scanMyrAmounts(original);
  const bad=(amounts.length>0&&(day==="expired"||ordinary||!campaignAmountRequested(text))) ||
    (day==="dec6" && /(?:12月5日|\b(?:5(?:th)?\s*dec(?:ember)?|dec(?:ember)?\s*5|5\s*disember)\b)/iu.test(original));
  // Also validate non-price drafts: slot confirmations and unsupported
  // duration claims can appear without RM or a named calendar date.
  if(!bad && campaignClaimsSafe(original,now))return original;
  return campaignContextReply({history,customerText:text,now,language}) ||
    localized(localeFor(history,text,language || campaignLanguage(history,text)),
      "这项胸部护理的具体安排需要由门店确认哦 😊",
      "The clinic will need to confirm the details of this breast-care enquiry. 😊",
      "Pusat perlu mengesahkan butiran pertanyaan penjagaan payudara ini. 😊");
}

// One campaign-specific boundary for text, booking and media. A verified
// new service selection exits the old event even if Gemini reused its facts.
function campaignHasVerifiedNewService({history,customerText,services,serviceAliases,resolveService}={}) {
  if(typeof resolveService!=="function")return false;
  const prior=priorCampaignTurns(history,customerText);
  const opener=prior.findLastIndex(t=>t?.role==="assistant"&&isCampaignOpening(t.content));
  if(opener<0)return false;
  return [...prior.slice(opener+1).filter(t=>t?.role==="user").map(t=>t.content),customerText].some(value=>{
    const text=String(value||"");
    if(isOtherTreatmentQuery(text))return true;
    // Breast-event wording also mentions pulse wave and moxibustion.
    // Those mentions alone do not establish a separately purchased service.
    const selected=resolveService(text,services,serviceAliases);
    if(!selected?.name || /(?:胸|乳|breast|payudara|\bRM\s*68\b)/iu.test(text))return false;
    if(/^(?:脉冲波调理|艾灸|草药胸部疏通乳腺护理)$/u.test(selected.name)) {
      const standalone=normalize(text)===normalize(selected.name);
      return standalone || isOtherTreatmentQuery(text);
    }
    return true;
  });
}
function selectCampaignReply({reply,fallback,history,customerText,language,now=Date.now()}={}){
  if(!fallback)return reply;
  const text=String(customerText||""), value=String(reply||"").trim();
  const locale=localeFor(history,text,language||campaignLanguage(history,text));
  const asked=campaignAmountRequested(text);
  if(!value||SCREENING.test(text)||campaignDateScope(history,text,now)==="ordinary"||campaignDay(now)==="expired")return fallback;
  if(!asked&&scanMyrAmounts(value).length)return fallback;
  const {clearReplyLanguageMismatch}=require("./replyLanguageGuard");
  if(clearReplyLanguageMismatch(value,locale)||!campaignClaimsSafe(value,now))return fallback;
  if(asked&&!hasMyrAmount(value,rm68CampaignSettings().campaign.priceMYR))return fallback;
  if(isCampaignAvailabilityQuestion(text)&&(!campaignDatesInText(value).length||!/(?:check|confirm|semak|sahkan|确认|確認)/iu.test(value)))return fallback;
  if(DURATION_QUESTION.test(text)){
    const claims=campaignDurationClaims(value);
    const asksCareOnly=/(?:breast care only|breast treatment only|penjagaan payudara sahaja|只做胸部护理|胸部护理本身|胸部護理本身)/iu.test(text);
    if(!claims.some(claim=>claim.scope===(asksCareOnly?"care":"total")))return fallback;
  }
  if(INCLUDES_QUESTION.test(text)&&!/(?:moxibustion|moksibusi|艾灸)/iu.test(value))return fallback;
  if(!hasMyrAmount(value,rm68CampaignSettings().campaign.priceMYR)&&!/(?:breast|payudara|胸部|乳腺|乳房|December|Disember|12月|moxibustion|moksibusi|艾灸)/iu.test(value))return fallback;
  return value;
}
function campaignContinuationPolicy({history,customerText,reply,now=Date.now(),verifiedNewService=false,language,branches,hours}={}) {
  if(verifiedNewService || !activeCampaignThread(history,customerText) || hasClinicalMediaRisk(customerText))return null;
  const adminKind=campaignAdministrativeKind(customerText);
  if(adminKind){
    const locale=localeFor(history,customerText,language||campaignLanguage(history,customerText));
    const facts=adminKind==="location"
      ?confirmedSingleBranchLocationAnswer({customerText,branches,language:locale,resolvedLanguage:locale,modelLocationOnly:true,omitInvitation:true})
      :confirmedBusinessHoursAnswer({customerText,hours,language:locale});
    const valid=facts&&(adminKind==="location"?verifyLocationDraft(reply,facts,{allowNeutralCourtesy:true})==="verified_address_only":verifyBusinessHoursDraft(reply,facts));
    const fallback=facts?.reply||localized(locale,
      adminKind==="location"?"门店地址需要请同事确认哦 😊":"营业时间需要请门店确认哦 😊",
      adminKind==="location"?"The clinic address needs to be confirmed by our staff. 😊":"Our staff will need to confirm the opening hours. 😊",
      adminKind==="location"?"Alamat pusat perlu disahkan oleh staf. 😊":"Waktu operasi perlu disahkan oleh staf. 😊");
    return {reply:valid?reply:fallback,textOnly:true,blocksBooking:true,administrativeKind:adminKind};
  }
  const answer=campaignContextReply({history,customerText,now,language});
  const guarded=guardCampaignPriceConflicts({history,customerText,reply,now,language});
  const corrected=answer?selectCampaignReply({reply:guarded,fallback:answer,history,customerText,language,now}):guarded;
  const scope=campaignDateScope(history,customerText,now);
  const currentScope=dateScope(customerText,now);
  const scheduling=isCampaignAvailabilityQuestion(customerText);
  // Ordinary-date care is not a booked event. An expired or rejected event
  // date cannot create booking-ready from a stale model classification.
  const blocksBooking=(scope==="ordinary" && (scheduling||currentScope==="ordinary")) ||
    campaignDay(now)==="expired" ||
    (Boolean(answer) && !scheduling);
  return {reply:corrected,blocksBooking,textOnly:Boolean(answer||corrected!==reply||
    (CAMPAIGN_QUERY.test(String(customerText||"")) && !verifiedNewService))};
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
  const recent=(candidate.recent_inbound_messages||[]).slice(0,5);
  const times=candidate.recent_inbound_times||[];
  if(recent.some((value,i)=>alternativeDateRequest(value,historicalTime({created_at:times[i]}))) ||
     /(?:applicable charges|regular-care price|requested date|clinic will need to confirm whether|caj yang berkenaan|tarikh yang anda minta|当天的收费|當天的收費|收费需要先请门店确认|其他日期是否可以安排)/iu.test(String(candidate.trigger_message_content||"")))
    return {expired:false,stop:true,message:null};
  const locale=localeFor([], null, detectConversationLanguage(candidate.recent_inbound_messages || [], "zh"));
  const {valid,campaign}=rm68CampaignSettings();
  if(!valid)return {expired:true,message:null};
  return {expired:false,message:campaign.followUp[day][locale]};
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
  campaignContextReply, guardCampaignPriceConflicts, screeningAcknowledgement,
  activeCampaignThread, campaignDateScope, campaignContinuationPolicy, campaignHasVerifiedNewService,
  alternativeDateRequest, alternativeDateContext, selectCampaignReply, campaignClaimsSafe, campaignDatesInText,
  candidateIsCampaign, campaignFollowUp, recoveryBreastOfferInvitation, recoveryBreastCampaignOpening,
};
