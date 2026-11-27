"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
const { isDefiniteAppointmentCancellation } = require("../src/utils/appointmentCancellationSafety");
const {
  CAMPAIGN_KEY, PREFILL, FOLLOWUP_PREFILL, isExactPrefill, isSimpleRm68Enquiry, campaignCreativeMatches,
  campaignDay, firstReply, hasCampaignConversation, isOtherTreatmentQuery,
  isCampaignAvailabilityQuestion, campaignContextReply, guardCampaignPriceConflicts, screeningAcknowledgement, campaignContinuationPolicy, campaignHasVerifiedNewService, candidateIsCampaign,
  campaignFollowUp,
} = require("../src/utils/neutroBreastRm68Campaign");

const early = Date.parse("2026-11-15T01:00:00Z");
const dec6 = Date.parse("2026-12-06T00:01:00Z");
const expired = Date.parse("2026-12-06T16:00:00Z");
const creative = {
  headline: "胸部专业检查 RM68体验优惠",
  body: "胸部健康评估+脉冲波疗程 12月5日及6日",
};
const history = [
  { role: "user", content: PREFILL },
  { role: "assistant", content: firstReply(early) },
];
function run(text, now = early) {
  return campaignContextReply({ history: [...history, { role: "user", content: text }], customerText: text, now });
}

test("RM68 creative verification fails closed for unrelated ads", () => {
  assert.equal(CAMPAIGN_KEY, "neutro_breast_rm68_2026");
  assert.equal(isExactPrefill(PREFILL), true);
  assert.equal(isExactPrefill(FOLLOWUP_PREFILL), true);
  assert.equal(isExactPrefill(FOLLOWUP_PREFILL + " 我今天能预约吗？"), false);
  assert.equal(isExactPrefill(PREFILL + " 今天可以吗？"), false);
  assert.equal(campaignCreativeMatches(creative), true);
  assert.equal(campaignCreativeMatches({ headline: "脉冲波 RM388", body: "胸部护理" }), false);
  assert.equal(campaignCreativeMatches({ headline: "骨盆 RM68", body: "Pelvic care" }), false);
  assert.equal(campaignCreativeMatches({ headline: "胸部护理", body: "" }), false);
  assert.equal(campaignCreativeMatches({ headline: "胸部护理 RM688", body: "" }), false);
  assert.equal(campaignCreativeMatches({ adName: "Breast Care RM68 Trial" }), true);
  assert.equal(campaignCreativeMatches({ campaignName: "胸部护理 RM68" }), true);
  assert.equal(campaignCreativeMatches(null), false);
});

test("RM68 first-turn recogniser supports short prefills, not unrelated or booking messages", () => {
  for (const message of [
    PREFILL, FOLLOWUP_PREFILL,
    "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】",
    "你好！我想了解【胸部专业检查 RM68体验优惠】",
    "请问 RM68 胸部护理体验还有吗？",
  ]) assert.equal(isSimpleRm68Enquiry(message), true, message);
  for (const message of [
    "你好，想了解黄金脉冲技术",
    "我想了解 RM688 胸部护理",
    "我对 RM68 盆骨护理有兴趣",
    "我想了解 RM68 胸部护理，还可以预约明天吗？",
    "我想了解 RM68 胸部护理的副作用",
    "请问 RM68 胸部护理在哪里？",
  ]) assert.equal(isSimpleRm68Enquiry(message), false, message);
  const shortened = "Hi～我对 Neutro Sense TCM【胸部专业检查 RM68体验优惠】";
  assert.equal(hasCampaignConversation([
    { role: "user", content: shortened }, { role: "assistant", content: firstReply(early) },
  ]), true, "a recognised shortened enquiry retains RM68 continuity once the welcome was sent");
  assert.equal(hasCampaignConversation([{ role: "user", content: shortened }]), false);
});

test("RM68 date options change on Malaysian calendar without inventing a booking", () => {
  assert.equal(campaignDay(early), "both");
  assert.equal(campaignDay(Date.parse("2026-12-05T15:59:59Z")), "both");
  assert.equal(campaignDay(Date.parse("2026-12-05T16:00:00Z")), "dec6");
  assert.equal(campaignDay(dec6), "dec6");
  assert.equal(campaignDay(expired), "expired");
  assert.match(firstReply(early), /12月5日（星期六）还是12月6日（星期日）/);
  assert.match(firstReply(dec6), /活动日期：12月6日/);
  assert.match(firstReply(dec6), /您12月6日（星期日）方便吗/);
  assert.doesNotMatch(firstReply(dec6), /12月5日（星期六）/);
  assert.doesNotMatch(firstReply(dec6), /12月5日 & 6日/);
  assert.match(firstReply(expired), /活动已经结束/);
  assert.doesNotMatch(firstReply(expired), /首次体验只需 RM68|名额有限/);
});

test("Only a genuine prior RM68 opening establishes campaign conversation", () => {
  assert.equal(hasCampaignConversation(history), true);
  assert.equal(hasCampaignConversation([
    { role: "user", content: FOLLOWUP_PREFILL },
    { role: "assistant", content: firstReply(early) },
  ]), true, "new opt-in-style enquiry keeps RM68 price continuity");
  assert.equal(hasCampaignConversation([{ role: "user", content: PREFILL }]), false);
  assert.equal(hasCampaignConversation([{ role: "user", content: PREFILL }, {
    role: "assistant", content: "Pulse Wave RM388 full-body"
  }]), false);
  assert.equal(hasCampaignConversation([{ role: "assistant", content: firstReply(early) }]), false);
});

test("RM68 follow-on queries preserve correct pricing, duration and event dates", () => {
  assert.match(run("这个多少钱？"), /RM68/);
  assert.doesNotMatch(run("这个多少钱？"), /RM388/);
  assert.match(run("请问这个是 RM388 吗？"), /RM388 属于另一项全身脉冲波护理优惠/);
  assert.match(run("做多久？"), /1小时30分钟/);
  assert.match(run("RM68 包括什么？"), /脉冲波/);
  assert.match(run("RM68 包括什么？"), /不等于医院的乳腺癌筛查/);
  assert.match(run("12月5日还有名额吗？", dec6), /12月6日/);
  assert.doesNotMatch(run("12月5日还有名额吗？", dec6), /12月5日/);
  assert.match(run("RM68 还有吗？", expired), /已于12月6日结束/);
  assert.equal(run("骨盆调理多少钱？"), null);
  assert.equal(run("3D 小颜术 RM488 多少钱？"), null);
  assert.equal(run("取消活动"), null);
  assert.equal(run("好的"), null);
  const changedTopic = [...history,
    { role: "user", content: "骨盆调理多少钱？" },
    { role: "assistant", content: "骨盆配套费用按当前优惠确认" },
    { role: "user", content: "多少钱？" },
  ];
  assert.equal(campaignContextReply({
    history: changedTopic, customerText: "多少钱？", now: early,
  }), null, "do not revive RM68 after customer switches treatments");
  assert.equal(isOtherTreatmentQuery("骨盆调理多少钱？"), true);
});

test("RM68 final reply guard removes cross-campaign RM388 terms only for relevant thread", () => {
  const check = (reply, customerText = "这个价钱多少？", now = early, h = history) =>
    guardCampaignPriceConflicts({ history: h, customerText, reply, now });
  assert.match(check("脉冲波 RM388，全程2小时15分钟"), /RM68/);
  assert.doesNotMatch(check("脉冲波 RM388，全程2小时15分钟"), /全程2小时15分钟/);
  assert.equal(check("骨盆 RM388", "骨盆调理多少钱？"), "骨盆 RM388",
    "explicit new treatment keeps its own price");
  assert.equal(check("一般 Pulse Wave RM388", "这个价钱多少？", early, []), "一般 Pulse Wave RM388");
  assert.match(check("首次体验 RM68", "这个价钱多少？", expired), /活动已于12月6日结束/);
  assert.doesNotMatch(check("12月5日有位", "活动哪天？", dec6), /12月5日/);
  assert.match(check("12月5日有位", "活动哪天？", dec6), /12月6日/);
});

test("RM68 event availability wording never guarantees a slot", () => {
  assert.match(firstReply(early), /具体名额需要由门店确认/);
  assert.match(run("还有名额吗？"), /具体名额需要由门店确认/);
  assert.equal(isCampaignAvailabilityQuestion("还有名额吗？"), true);
  assert.equal(isCampaignAvailabilityQuestion("RM68 有位吗？"), true);
  assert.equal(isCampaignAvailabilityQuestion("这个多少钱？"), false);
});

test("verified RM68 availability review can recover without silencing clinical reviews", async () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const start = server.indexOf("    // An RM68 campaign slot enquiry is answerable");
  const end = server.indexOf("    // A non-urgent urinary symptom", start);
  assert.ok(start > 0 && end > start, "review recovery precedes staff review persistence");
  const fragment = server.slice(start, end);
  const runReview = vm.runInNewContext(`(async function(input) {
    const text = input.text;
    const history = input.history;
    const commercialHistory = input.commercialHistory || history;
    const channel = "whatsapp";
    const mediaLanguage = "zh";
    const clinicConfig = { businessType: "tcm_clinic", businessName: "Neutro Sense TCM" };
    const naturalReplyAuthority = input.naturalReplyAuthority === true;
    const contact = { id: 8701 };
    const savedInbound = { id: 20787 };
    const keywordReason = input.keywordReason || null;
    const urgentSafety = false;
    const marketingStopQuestion = null;
    let flagged = true, reviewRequired = true;
    let reviewType = input.reviewType || "information";
    let reply = "model asked for staff review";
    const languageCheckedModelReply = input.checkedDraft || null;
    let bookingReady = false, clinicalAcknowledgement = null;
    let priceQuery = false, packageQuery = false, serviceQuery = false;
    let serviceQuerySource = null, details = null, reviewContinuationTextOnly = false;
    const contactsRepo = {
      getTcmReviewEvidence: async () => ({ pendingClinicalReview: input.pendingClinicalReview === true }),
    };
    ${fragment}
    return { flagged, reviewRequired, reply, reviewContinuationTextOnly };
  })`, {
    selectVerifiedRoutineReply: require("../src/utils/neutroAiReplyAuthority").selectVerifiedRoutineReply, resolveAiReplyAuthorityMode: require("../src/utils/neutroAiReplyAuthority").resolveAiReplyAuthorityMode, routineReviewTextOnlyState: require("../src/utils/neutroAiReplyAuthority").routineReviewTextOnlyState, routineReviewRecoveryEligible: require("../src/utils/neutroAiReplyAuthority").routineReviewRecoveryEligible, replyOverrideAudit: require("../src/utils/neutroAiReplyAuthority").createReplyOverrideAudit(()=>{}),
    isActiveSafetyConcern: text => /urgent|emergency/iu.test(text),
    hasClinicalMediaRisk,
    isExplicitStaffRequest: text => /人工|staff/iu.test(text),
    isDefiniteAppointmentCancellation,
    isCampaignAvailabilityQuestion,
    campaignContextReply: ({ history, customerText }) =>
      campaignContextReply({ history, customerText, now: early }),
    administrativeReviewReply: () => null,
    console: { info: () => {} },
  });
  const getHistory = text => [...history, { role: "user", content: text }];
  const recovered = await runReview({ text: "还有名额吗？", history: getHistory("还有名额吗？") });
  assert.equal(recovered.flagged, false);
  assert.equal(recovered.reviewRequired, false);
  assert.equal(recovered.reviewContinuationTextOnly, true);
  assert.match(recovered.reply, /具体名额需要由门店确认/);
  const blockedClinical = await runReview({
    text: "还有名额吗？", history: getHistory("还有名额吗？"), pendingClinicalReview: true,
  });
  assert.equal(blockedClinical.reviewRequired, true);
  const clinicalOutcome = await runReview({
    text: "还有名额吗？", history: getHistory("还有名额吗？"), reviewType: "clinical",
  });
  assert.equal(clinicalOutcome.reviewRequired, true);
  const medicalQuestion = "我怀孕了还有名额吗？";
  assert.equal((await runReview({ text: medicalQuestion,
    history: getHistory(medicalQuestion) })).reviewRequired, true);
  const cancellation = "我想取消预约，还有名额吗？";
  assert.equal((await runReview({ text: cancellation,
    history: getHistory(cancellation) })).reviewRequired, true);
  assert.equal((await runReview({ text: "还有名额吗？",
    history: getHistory("还有名额吗？"), keywordReason: "complaint" })).reviewRequired, true);
});

test("RM68 follow-ups require anchored customer campaign and are text-only", () => {
  const candidate = {
    channel: "whatsapp",
    trigger_message_content: firstReply(early),
    recent_inbound_messages: [PREFILL],
    recent_service_messages: [PREFILL],
    ad_followup_source: "meta_ads",
    ad_followup_headline: creative.headline,
    ad_followup_body: creative.body,
  };
  assert.equal(candidateIsCampaign(candidate), true);
  const newPrefillCandidate = { ...candidate,
    recent_inbound_messages: [FOLLOWUP_PREFILL],
    recent_service_messages: [FOLLOWUP_PREFILL],
  };
  assert.equal(candidateIsCampaign(newPrefillCandidate), true);
  assert.match(campaignFollowUp({ candidate: newPrefillCandidate, now: early }).message, /RM68/);
  assert.doesNotMatch(campaignFollowUp({ candidate: newPrefillCandidate, now: early }).message, /RM388/);
  assert.equal(candidateIsCampaign({ ...newPrefillCandidate, ad_followup_source: "direct" }), false);
  assert.equal(candidateIsCampaign({ ...newPrefillCandidate,
    ad_followup_headline: "黄金脉冲技术 RM388", ad_followup_body: "脉冲波护理",
  }), false, "non-RM68 ad cannot enable the event");
  assert.match(campaignFollowUp({ candidate, now: early }).message, /RM68/);
  assert.match(campaignFollowUp({ candidate, now: early }).message, /1小时30分钟/);
  assert.doesNotMatch(campaignFollowUp({ candidate, now: early }).message, /RM388/);
  assert.match(campaignFollowUp({ candidate, now: dec6 }).message, /今天12月6日/);
  assert.deepEqual(campaignFollowUp({ candidate, now: expired }), { expired: true, message: null });
  assert.equal(candidateIsCampaign({ ...candidate, ad_followup_body: "一般疗程", ad_followup_headline: "脉冲波 RM388" }), false);
  assert.equal(candidateIsCampaign({ ...candidate, ad_followup_source: "direct" }), false);
  assert.equal(candidateIsCampaign({ ...candidate, recent_inbound_messages: ["Hello"], recent_service_messages: ["Hello"] }), true,
    "verified saved opener remains authoritative after customer replies");
  assert.equal(campaignFollowUp({ candidate: { ...candidate, recent_inbound_messages: ["骨盆调理多少钱？"] }, now: early }), null);
  assert.equal(campaignFollowUp({ candidate: { ...candidate, trigger_message_content: "您好，我们的脉冲波 RM388" }, now: early })?.expired, false);
});

test("Production paths include RM68 scoped continuation and follow-up guards", () => {
  const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const follow = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  const fixed = fs.readFileSync(path.join(__dirname, "../src/utils/fixedAdFirstReply.js"), "utf8");
  assert.match(fixed, /campaignCreativeMatches\(metaAdContext\)/);
  assert.match(server, /campaignContextReply\(\{/);
  assert.match(server, /campaignContinuationPolicy\(\{/);
  assert.match(server, /neutro_breast_rm68_continuation_text_only/);
  assert.match(follow, /campaignFollowUp\(\{ candidate \}\)/);
  assert.match(follow, /neutro_rm68_campaign_expired/);
  assert.match(follow, /!rm68FollowUp && !originalHasPrice/);
  const secondaryService = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappSecondaryFollowUpService.js"), "utf8");
  const secondaryMarketing = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappSecondaryMarketingFollowUpService.js"), "utf8");
  const freeEntry = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(secondaryService, /rule\.slot_hours IN\s*\(2,6,20\)/,
    "2h, 6h and 20h service follow-up slots remain separate");
  assert.match(secondaryMarketing, /const SLOTS=new Set\(\[48,66,96,144\]\)/);
  assert.match(secondaryMarketing, /lead\.marketing_consent='opted_in'/,
    "extended marketing still checks recorded consent");
  assert.match(secondaryMarketing, /event_reply\.content LIKE '%首次体验只需 RM68%'/,
    "RM68 event must not receive ordinary RM388 extended marketing templates");
  assert.match(freeEntry, /event_reply\.content LIKE '%首次体验只需 RM68%'/,
    "RM68 event must not use unrelated free-entry marketing graphics");
});

test("RM68 rejects unavailable event dates, answers the screening question and keeps English",()=>{
  const h=[...history,
    {role:"user",content:"How to conduct the checking"},
    {role:"assistant",content:"A wellness assessment followed by pulse-wave care."},
    {role:"user",content:"Any ultrasound screening"},
    {role:"user",content:"December 5 and 6, I am not available\nIs that possible to do the treatment and checking today"},
  ];
  const text=h.at(-1).content;
  const answer=campaignContextReply({history:h,customerText:text,now:early});
  assert.match(answer,/today/);
  assert.match(answer,/clinic will need to confirm/i);
  assert.match(answer,/ultrasound/);
  assert.doesNotMatch(answer,/RM\s*68|December [56]|12月|[\u3400-\u9fff]/u);
  const screening=screeningAcknowledgement({history:h.slice(0,-1),customerText:h.at(-2).content});
  assert.match(screening,/cannot|can’t confirm/i);
  assert.match(screening,/staff will need to check/i);
  assert.equal(isCampaignAvailabilityQuestion("Any ultrasound screening"),false);
  assert.equal(screeningAcknowledgement({history:[],customerText:"Any ultrasound screening"}),null);
  assert.equal(screeningAcknowledgement({history:h,customerText:"I have a breast lump, can ultrasound help?"}),null);
  const price=campaignContextReply({history:[...h,{role:"user",content:"How much?"}],customerText:"How much?",now:early});
  assert.match(price,/price also needs to be confirmed separately/i);
  assert.doesNotMatch(price,/RM\s*68/i);
});
test("campaign factual continuation does not invent prices for ordinary questions",()=>{
  assert.doesNotMatch(run("做多久？"),/RM\s*68/);
  assert.doesNotMatch(run("还有名额吗？"),/RM\s*68/);
  assert.equal(run("胸部护理有什么作用？"),null);
  const mixed=campaignContextReply({history,customerText:"Can I book today?",now:early});
  assert.match(mixed,/clinic will need to confirm/i);
  assert.doesNotMatch(mixed,/RM\s*68/);
  const localized=campaignContextReply({history,customerText:"Ada slot hari ini?",now:early});
  assert.match(localized,/Pusat perlu mengesahkan/);
  assert.doesNotMatch(localized,/RM\s*68/);
});

test("campaign scope follows actual customer dates and latest service choice",()=>{
  const before=[...history,{role:"user",content:"因为刚好这两天我不在kl😭"},
    {role:"assistant",content:"可以帮你确认其他日期"}];
  const ordinary=campaignContextReply({history:before,customerText:"价钱呢？",now:early});
  assert.match(ordinary,/其他日期/);
  assert.match(ordinary,/收费需要先请门店确认/);
  assert.doesNotMatch(ordinary,/RM\s*68/);
  const dateOnly=campaignContextReply({history,customerText:"活动哪天？",now:dec6});
  assert.match(dateOnly,/12月6日/);
  assert.doesNotMatch(dateOnly,/12月5日|RM\s*68/);
  const reselected=campaignContextReply({history:[...before,{role:"user",content:"12月6日方便"},{role:"assistant",content:"可以确认"}],customerText:"价钱呢？",now:early});
  assert.match(reselected,/RM68/);
  const other=[...history,{role:"user",content:"pulse wave"},{role:"assistant",content:"Sure"}];
  assert.equal(campaignContextReply({history:other,customerText:"price?",now:early}),null);
  const aliases=[{name:"徒手体态调理"}];
  const selected=campaignHasVerifiedNewService({history:[...history,{role:"user",content:"徒手调理"},{role:"assistant",content:"好"}],
    customerText:"价格？",services:aliases,serviceAliases:[],resolveService:t=>t==="徒手调理"?aliases[0]:null});
  assert.equal(selected,true);
  assert.equal(campaignContinuationPolicy({history,customerText:"价格？",reply:"RM388",now:early,verifiedNewService:selected}),null);
});
test("real final campaign boundary checks booking-ready and respects service switch",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const start=server.indexOf("    // Validate event scope even if the model classified");
  const end=server.indexOf("    // Final exact-copy boundary",start);
  assert.ok(start>=0&&end>start);
  const source=server.slice(start,end);
  const run=(text,history,selected=false)=>vm.runInNewContext(
    "(function(){"+source+"\nreturn {reply,bookingReady,details,rm68BlocksBooking,rm68CampaignContinuationTextOnly};})()",{
      selectVerifiedRoutineReply: require("../src/utils/neutroAiReplyAuthority").selectVerifiedRoutineReply, resolveAiReplyAuthorityMode: require("../src/utils/neutroAiReplyAuthority").resolveAiReplyAuthorityMode, routineReviewTextOnlyState: require("../src/utils/neutroAiReplyAuthority").routineReviewTextOnlyState, routineReviewRecoveryEligible: require("../src/utils/neutroAiReplyAuthority").routineReviewRecoveryEligible, replyOverrideAudit: require("../src/utils/neutroAiReplyAuthority").createReplyOverrideAudit(()=>{}),
      flagged:false,bookingReady:true,marketingStopQuestion:false,keywordReason:null,urgentSafety:false,
      mediaLanguage:"en",text,reply:"Your event appointment is confirmed for RM68 on December 5.",details:{appointmentPreference:"December 5"},
      fixedAdFirstReply:null,staffPriceConflict:false,clinicConfig:{businessType:"tcm_clinic",businessName:"Neutro Sense TCM"},
      commercialHistory:history,isActiveSafetyConcern:()=>false,hasClinicalMediaRisk:()=>false,
      isExplicitStaffRequest:()=>false,isDefiniteAppointmentCancellation:()=>false,safeServiceFromCustomer:()=>null,
      campaignHasVerifiedNewService:()=>selected,campaignContinuationPolicy:args=>campaignContinuationPolicy({...args,now:early}),
      priceQuery:true,packageQuery:false,serviceQuery:true,serviceQuerySource:"model",
    });
  const invalid=run("December 5 and 6, I am not available. Can I book today?",history);
  assert.equal(invalid.bookingReady,false);
  assert.equal(invalid.details.appointmentPreference,null);
  assert.equal(invalid.rm68CampaignContinuationTextOnly,true);
  assert.doesNotMatch(invalid.reply,/RM68|December 5/);
  const other=run("徒手调理",history,true);
  assert.equal(other.rm68CampaignContinuationTextOnly,false);
});
test("screening uses actual review persistence and guarded acknowledgement, never a media send",async()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const a=server.indexOf("    // An unverified screening capability");
  const b=server.indexOf("    // Coexistence staff",a);
  const c=server.indexOf("    if (flagged && reviewRequired) {",b);
  const d=server.indexOf("    } else if (flagged) {",c);
  assert.ok(a>=0&&b>a&&c>b&&d>c);
  const text="Any ultrasound screening";
  for(const allowed of [true,false]){
    const actions=[];
    const context={selectVerifiedRoutineReply: require("../src/utils/neutroAiReplyAuthority").selectVerifiedRoutineReply, resolveAiReplyAuthorityMode: require("../src/utils/neutroAiReplyAuthority").resolveAiReplyAuthorityMode, routineReviewTextOnlyState: require("../src/utils/neutroAiReplyAuthority").routineReviewTextOnlyState, routineReviewRecoveryEligible: require("../src/utils/neutroAiReplyAuthority").routineReviewRecoveryEligible, replyOverrideAudit: require("../src/utils/neutroAiReplyAuthority").createReplyOverrideAudit(()=>{}), naturalReplyAuthority:false, modelPricingIntent:null, originalModelReply:null,
      flagged:false,reviewRequired:false,reviewType:null,bookingReady:true,priceQuery:true,packageQuery:true,
      serviceQuery:true,serviceQuerySource:"model",clinicalAcknowledgement:null,
      keywordReason:null,urgentSafety:false,marketingStopQuestion:false,mediaLanguage:"en",text,commercialHistory:[...history,{role:"user",content:text}],
      clinicConfig:{businessType:"tcm_clinic",businessName:"Neutro Sense TCM"},
      isActiveSafetyConcern:()=>false,isExplicitStaffRequest:()=>false,isDefiniteAppointmentCancellation:()=>false,
      clearReplyLanguageMismatch:require("../src/utils/replyLanguageGuard").clearReplyLanguageMismatch,
      recordedReviewAcknowledgement:require("../src/utils/neutroAiReplyAuthority").recordedReviewAcknowledgement,
      screeningAcknowledgement,contactsRepo:{setAiReviewAttention:async(...args)=>actions.push(["review",...args])},
      contact:{id:42},savedInbound:{id:123},categorizeAiReview:()=> "information",
      getAiOwnedContact:async()=>allowed?{id:42}:null,canSendAutomatedReply:()=>allowed,
      sendTrackedText:async(...args)=>actions.push(["text",...args]),channel:"whatsapp",from:"synthetic",
      responseAttempted:false,processingJobId:"test",wasFirstMessage:false,
    };
    await vm.runInNewContext("(async()=>{"+server.slice(a,b)+server.slice(c,d)+"\n}})()",context);
    assert.equal(actions[0][0],"review");
    assert.equal(actions[0][2],123);
    assert.equal(actions.length,allowed?2:1);
    if(allowed){
      assert.match(actions[1][2],/ultrasound/);
      assert.equal(actions[1][4].reviewReplyToInboundMessageId,123);
    }
  }
});


test("Hui's English alternative date request gets a localized non-confirming answer",()=>{
  const {selectCampaignReply,alternativeDateRequest}=require("../src/utils/neutroBreastRm68Campaign");
  const text="December 5 and 6, I am not available\nIs that possible to do the treatment and checking today";
  const h=[...history,{role:"user",content:"How to conduct the checking"},{role:"assistant",content:"Our practitioner will conduct a consultation."},{role:"user",content:"Any ultrasound screening"},{role:"user",content:text}];
  const fallback=campaignContextReply({history:h,customerText:text,now:early,language:"en"});
  assert.match(fallback,/clinic will need to confirm/i);
  assert.match(fallback,/today/);
  assert.doesNotMatch(fallback,/[\u3400-\u9fff]|RM68|which day/i);
  assert.match(fallback,/ultrasound/i);
  assert.equal(selectCampaignReply({reply:"Would December 5 or 6 suit you?",fallback,history:h,customerText:text,language:"en",now:early}),fallback);
  assert.equal(alternativeDateRequest("Can I come today?",dec6),false);
  assert.equal(alternativeDateRequest(text,early),true);
  const next=[...h,{role:"assistant",content:fallback},{role:"user",content:"How much?"}];
  assert.match(campaignContextReply({history:next,customerText:"How much?",now:early,language:"en"}),/price also needs to be confirmed separately/i);
});

test("RM68 localized opening, continuation and reminders retain campaign evidence",()=>{
  const {selectCampaignReply}=require("../src/utils/neutroBreastRm68Campaign");
  for(const [language,question,prefill] of [["en","How much is the breast care?","I am interested in the RM68 breast care trial"],["ms","Berapa harga?","Saya berminat dengan RM68 breast care trial"]]){
    const h=[{role:"user",content:prefill},{role:"assistant",content:firstReply(early,language)},{role:"user",content:question}];
    assert.equal(hasCampaignConversation(h),true);
    const fallback=campaignContextReply({history:h,customerText:question,now:early,language});
    assert.match(fallback,/RM68/);
    assert.doesNotMatch(fallback,/[\u3400-\u9fff]/);
    assert.equal(selectCampaignReply({reply:"RM388",fallback,history:h,customerText:question,language,now:early}),fallback);
  }
  const enQuestion="How much is the breast care?";
  const enFallback=campaignContextReply({history,customerText:enQuestion,now:early,language:"en"});
  const draft="The first trial is RM68 for the December 5 and 6 event 😊";
  assert.equal(selectCampaignReply({reply:draft,fallback:enFallback,history,customerText:enQuestion,language:"en",now:early}),draft);
  const candidate={trigger_message_content:firstReply(early),recent_inbound_messages:["Where is your location",PREFILL],ad_followup_source:"meta_ads",ad_followup_headline:creative.headline,ad_followup_body:creative.body};
  assert.match(campaignFollowUp({candidate,now:early}).message,/friendly reminder/);
  assert.doesNotMatch(campaignFollowUp({candidate,now:early}).message,/[\u3400-\u9fff]/);
});


test("campaign claims validate prices, calendar dates and duration in context",()=>{
  const {campaignClaimsSafe}=require("../src/utils/neutroBreastRm68Campaign");
  for(const invalid of [
    "The event is RM68 on December 12.",
    "The trial is RM90 on December 5 and 6.",
    "The event is on November 5 and 6.",
    "The trial is RM68 on December 5 and 6, also available anytime.",
    "The trial is RM68 on December 5 and 6, every day.",
    "The event is RM68 on 12/12/2026.",
    "The RM68 event on December 5 and 6 takes 5 hours.",
    "Promosi RM68 pada 12 Disember.",
    "RM68 活动日期12月12日。",
    "The RM68 event on December 5 has confirmed slots.",
  ]) assert.equal(campaignClaimsSafe(invalid,early),false,invalid);
  assert.equal(campaignClaimsSafe("The first trial is RM68 for the December 5 and 6 event 😊",early),true);
  assert.equal(campaignClaimsSafe("The RM68 trial is on December 6 and takes 1 hour 30 minutes.",dec6),true);
  assert.equal(campaignClaimsSafe("The RM68 trial is on December 5.",dec6),false);
  assert.equal(campaignClaimsSafe("The RM68 trial is on December 6.",expired),false);
});

test("relative scheduling uses the original message timestamp and never mistakes results for bookings",()=>{
  const {alternativeDateRequest,alternativeDateContext}=require("../src/utils/neutroBreastRm68Campaign");
  assert.equal(alternativeDateRequest("Will I see results today?",early),false);
  assert.equal(isCampaignAvailabilityQuestion("Will I see results today?"),false);
  assert.equal(run("Can I see breast treatment results today?"),null);
  assert.equal(alternativeDateRequest("Can I come on December 12?",early),true);
  const oldEventVisit=[...history,{role:"user",content:"Can I come today?",pricingCreatedAtMs:Date.parse("2026-12-05T01:00:00Z")}];
  assert.equal(alternativeDateContext(oldEventVisit,"How much?",dec6),false);
  const priorOutside=[...history,{role:"user",content:"Can I come today?",pricingCreatedAtMs:early}];
  assert.equal(alternativeDateContext(priorOutside,"How much?",dec6),true);
  assert.equal(alternativeDateContext(priorOutside,"Can I book December 6?",dec6),false);
  assert.equal(alternativeDateContext([...history,{role:"user",content:"Can I come today?"}],"How much?",early),false);
});

test("alternative-date follow-up stops the sequence rather than sending repeated reminders",()=>{
  const candidate={trigger_message_content:firstReply(early),recent_inbound_messages:["Can I come today?",PREFILL],
    recent_inbound_times:[new Date(early).toISOString(),new Date(early-1000).toISOString()],
    ad_followup_source:"meta_ads",ad_followup_headline:creative.headline,ad_followup_body:creative.body};
  assert.deepEqual(campaignFollowUp({candidate,now:early}),{expired:false,stop:true,message:null});
  const visitOnEvent={...candidate,recent_inbound_times:[new Date(dec6).toISOString(),new Date(early).toISOString()]};
  assert.equal(campaignFollowUp({candidate:visitOnEvent,now:dec6}).stop,undefined);
});

test("localized fallbacks distinguish amount, duration and inclusions",()=>{
  const local=(q,language)=>campaignContextReply({history,customerText:q,language,now:early});
  for(const [lang,price,duration,inclusions] of [["en","How much?","How long?","What is included?"],["ms","Berapa harga?","Berapa lama?","Apa yang termasuk?"]]){
    const a=local(price,lang),b=local(duration,lang),c=local(inclusions,lang);
    assert.ok(a&&b&&c,lang);
    assert.match(a,/RM68/);
    assert.match(b,/45/);
    assert.match(c,/moxibustion|moksibusi/);
    assert.notEqual(a,b);assert.notEqual(b,c);assert.notEqual(a,c);
  }
});

test("actual server review boundary routes Hui's alternative date for staff even if model says booking-ready",async()=>{
  const helpers=require("../src/utils/neutroBreastRm68Campaign");
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const a=source.indexOf("    // An alternative date needs actual staff confirmation");
  const b=source.indexOf("    // Final clinical safety backstop",a);
  assert.ok(a>0&&b>a);
  const text="December 5 and 6, I am not available\nIs that possible to do the treatment and checking today";
  const commercialHistory=[...history,{role:"user",content:"Any ultrasound screening"},{role:"user",content:text}];
  for(const bookingReady of [true,false]){
    const context={selectVerifiedRoutineReply: require("../src/utils/neutroAiReplyAuthority").selectVerifiedRoutineReply, resolveAiReplyAuthorityMode: require("../src/utils/neutroAiReplyAuthority").resolveAiReplyAuthorityMode, routineReviewTextOnlyState: require("../src/utils/neutroAiReplyAuthority").routineReviewTextOnlyState, routineReviewRecoveryEligible: require("../src/utils/neutroAiReplyAuthority").routineReviewRecoveryEligible, replyOverrideAudit: require("../src/utils/neutroAiReplyAuthority").createReplyOverrideAudit(()=>{}), naturalReplyAuthority:false, modelPricingIntent:null, ...helpers,text,commercialHistory,bookingReady,flagged:false,fixedAdFirstReply:null,staffPriceConflict:false,safeServiceFromCustomer:()=>null,reviewRequired:false,reviewType:null,
      keywordReason:null,urgentSafety:false,marketingStopQuestion:null,mediaLanguage:"en",
      clinicalAcknowledgement:null,serviceQuery:true,serviceQuerySource:"model",priceQuery:true,packageQuery:true,details:{treatment:"pulse wave"},
      savedInbound:{id:24036,created_at:new Date(early).toISOString()},
      clinicConfig:{businessType:"tcm_clinic",businessName:"Neutro Sense TCM"},
      isActiveSafetyConcern:()=>false,hasClinicalMediaRisk:()=>false,isExplicitStaffRequest:()=>false,isDefiniteAppointmentCancellation:()=>false,hasExplicitPriceRequest:()=>false,
    };
    const result=vm.runInNewContext("(function(){"+source.slice(a,b)+";return {flagged,reviewRequired,reviewType,bookingReady,priceQuery,serviceQuery,clinicalAcknowledgement};})()",context);
    assert.equal(result.flagged,true);
    assert.equal(result.reviewRequired,true);
    assert.equal(result.reviewType,"information");
    assert.equal(result.bookingReady,false);
    assert.equal(result.priceQuery,false);
    assert.equal(result.serviceQuery,false);
    assert.match(result.clinicalAcknowledgement,/clinic will need to confirm/i);
    assert.doesNotMatch(result.clinicalAcknowledgement,/[\u3400-\u9fff]/);
  }
});


test("Stage 21 preserves qualified campaign availability but not unconfirmed bookings",()=>{
  const {campaignClaimsSafe}=require("../src/utils/neutroBreastRm68Campaign");
  for(const [language,customerText,reply] of [
    ["en","How much?","The first trial is RM68 for the December 5 and 6 event. Availability must be confirmed by the clinic."],
    ["ms","Berapa harga?","Promosi RM68 pada 5 dan 6 Disember. Slot perlu disahkan oleh pusat."],
    ["zh","多少钱？","12月5日及6日活动首次体验 RM68，具体名额需要由门店确认。"],
  ]){
    assert.equal(campaignClaimsSafe(reply,early),true,reply);
    assert.equal(campaignContinuationPolicy({history,customerText,reply,language,now:early}).reply,reply);
  }
  for(const reply of ["Your appointment is confirmed.","The breast care takes 5 hours.",
    "Availability must be confirmed by the clinic, but your appointment is confirmed."]){
    assert.notEqual(guardCampaignPriceConflicts({history,customerText:"Can you tell me more about breast care?",
      reply,language:"en",now:early}),reply);
  }
});


test("RM68 amounts obey one campaign disclosure policy across currency formats",()=>{
  const {campaignClaimsSafe}=require("../src/utils/neutroBreastRm68Campaign");
  for(const amount of ["RM68","MYR 68.00","马币68","RM 6️⃣8️⃣","令吉68"]){
    const draft="The first trial is "+amount+" for the December 5 and 6 event.";
    assert.equal(campaignClaimsSafe(draft,early),true,draft);
    assert.equal(campaignClaimsSafe(draft,expired),false,draft);
    const allowed=campaignContinuationPolicy({history,customerText:"How much?",reply:draft,language:"en",now:early});
    assert.equal(allowed.reply,draft,draft);
    const unsolicited=guardCampaignPriceConflicts({history,customerText:"How long?",reply:draft,language:"en",now:early});
    assert.notEqual(unsolicited,draft,draft);
  }
  for(const amount of ["MYR 68.50","RM68.00.50","RM680","RM-68","RM6,8","RM68k","RM68-100","RM68 + 20"]){
    assert.equal(campaignClaimsSafe("The trial is "+amount+" on December 5.",early),false,amount);
  }
});

test("RM68 duration claims distinguish the care component and whole visit",()=>{
  const {campaignClaimsSafe}=require("../src/utils/neutroBreastRm68Campaign");
  for(const valid of [
    "Breast care takes about 45 minutes, or about 90 minutes in total.",
    "The full visit takes 90 minutes.",
    "胸部护理约45分钟，全程约1小时30分钟。",
    "Penjagaan payudara sekitar 45 minit, keseluruhan 90 minit.",
    "The event takes 1.5 hours.",
    "The full visit takes 1h30.",
    "The full visit takes 1 hour and 30 minutes."
  ]) assert.equal(campaignClaimsSafe(valid,early),true,valid);
  for(const invalid of [
    "Breast care takes 90 minutes.",
    "The full visit takes 45 minutes.",
    "Breast care takes 90 minutes, with 45 minutes in total.",
    "胸部护理90分钟，全程45分钟。",
    "Penjagaan payudara 90 minit, keseluruhan 45 minit.",
    "The event takes 2h15."
  ]) assert.equal(campaignClaimsSafe(invalid,early),false,invalid);
});


test("a whole-visit duration question cannot pass with only the care component",()=>{
  const draft="Breast care takes 45 minutes.";
  const customerText="How long is the full visit?";
  const result=campaignContinuationPolicy({history,customerText,reply:draft,language:"en",now:early});
  assert.notEqual(result.reply,draft);
  assert.match(result.reply,/90/);
});


test("RM68 history does not reinterpret verified addresses, postcodes or business hours as event facts",()=>{
  const branches=[{name:"Petaling Jaya (PJ)",address:"C-12-6, Dataran 3 Two Business Centre, Jalan 19, Section 19/1, 46300 Petaling Jaya, Selangor"}];
  const hours={weekly:{monday:null,tuesday:{open:"10:00",close:"20:00"},wednesday:{open:"10:00",close:"20:00"},thursday:{open:"10:00",close:"20:00"},friday:{open:"10:00",close:"20:00"},saturday:{open:"10:00",close:"18:00"},sunday:{open:"10:00",close:"18:00"}}};
  for(const now of [early,dec6,expired]){
    for(const [customerText,language] of [["at where ya","en"],["店在哪里","zh"],["Where is your clinic?","en"],["alamat klinik?","ms"]]){
      assert.equal(campaignContextReply({history,customerText,now,language}),null);
      const outcome=campaignContinuationPolicy({history,customerText,now,language,branches,hours,reply:"The clinic will need to confirm the details of this breast-care enquiry."});
      assert.equal(outcome.administrativeKind,"location",customerText);
      assert.ok(outcome.reply.includes(branches[0].address),customerText);
      assert.doesNotMatch(outcome.reply,/RM68|RM388/);
      assert.equal(outcome.blocksBooking,true);
      assert.equal(outcome.textOnly,true);
    }
    for(const [customerText,language] of [["营业时间","zh"],["What time do you open?","en"],["Waktu operasi?","ms"]]){
      const outcome=campaignContinuationPolicy({history,customerText,now,language,branches,hours,reply:"The trial takes 90 minutes."});
      assert.equal(outcome.administrativeKind,"hours");
      assert.match(outcome.reply,/10:00-20:00/);
      assert.match(outcome.reply,/10:00-18:00/);
      assert.doesNotMatch(outcome.reply,/RM68|90 minutes/);
      assert.equal(outcome.blocksBooking,true);
      assert.equal(outcome.textOnly,true);
    }
  }
  const reply="Our address: "+branches[0].address;
  assert.equal(campaignContinuationPolicy({history,customerText:"at where ya",reply,language:"en",branches,hours,now:early}).reply,reply);
  assert.equal(campaignContinuationPolicy({history,customerText:"店在哪里",reply:"RM68, your appointment is confirmed.",language:"zh",branches,hours,now:early}).reply.includes(branches[0].address),true);
  assert.equal(campaignContinuationPolicy({history,customerText:"What do you accept for payment?",reply:"Please check with our staff about payment options.",language:"en",now:early}),null);
  assert.equal(campaignContinuationPolicy({history,customerText:"谢谢",reply:"不客气 😊",language:"zh",now:expired}),null);
  for(const customerText of ["胸部哪里痛","How long is the treatment?","RM68 还有名额吗？","店在哪里，多少钱？"]){
    const result=campaignContinuationPolicy({history,customerText,reply:"RM68 every day",language:"zh",branches,hours,now:early});
    assert.notEqual(result?.administrativeKind,"location",customerText);
    assert.notEqual(result?.administrativeKind,"hours",customerText);
  }
});
