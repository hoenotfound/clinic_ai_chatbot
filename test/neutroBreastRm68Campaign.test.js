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
    const contact = { id: 8701 };
    const savedInbound = { id: 20787 };
    const keywordReason = input.keywordReason || null;
    const urgentSafety = false;
    const marketingStopQuestion = null;
    let flagged = true, reviewRequired = true;
    let reviewType = input.reviewType || "information";
    let reply = "model asked for staff review";
    let bookingReady = false, clinicalAcknowledgement = null;
    let priceQuery = false, packageQuery = false, serviceQuery = false;
    let serviceQuerySource = null, details = null, reviewContinuationTextOnly = false;
    const contactsRepo = {
      getTcmReviewEvidence: async () => ({ pendingClinicalReview: input.pendingClinicalReview === true }),
    };
    ${fragment}
    return { flagged, reviewRequired, reply, reviewContinuationTextOnly };
  })`, {
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
      flagged:false,bookingReady:true,marketingStopQuestion:false,keywordReason:null,urgentSafety:false,
      text,reply:"Your event appointment is confirmed for RM68 on December 5.",details:{appointmentPreference:"December 5"},
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
    const context={
      flagged:false,reviewRequired:false,reviewType:null,bookingReady:true,priceQuery:true,packageQuery:true,
      serviceQuery:true,serviceQuerySource:"model",clinicalAcknowledgement:null,
      keywordReason:null,urgentSafety:false,marketingStopQuestion:false,text,commercialHistory:[...history,{role:"user",content:text}],
      clinicConfig:{businessType:"tcm_clinic",businessName:"Neutro Sense TCM"},
      isActiveSafetyConcern:()=>false,isExplicitStaffRequest:()=>false,isDefiniteAppointmentCancellation:()=>false,
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
