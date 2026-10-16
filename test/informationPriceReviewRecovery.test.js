"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config/clinicConfig");
const { planInformationPriceRecovery } = require("../src/utils/informationPriceReviewRecovery");
const { resolveVerifiedPriceFollowUpService } = require("../src/utils/priceFollowUpContext");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");

const services = [
  { name:"骨盆调理", priceRange:"" },
  { name:"产后调理", priceRange:"" },
  { name:"徒手体态调理", priceRange:"" },
  { name:"3D 小颜术", priceRange:"" },
];
const serviceAliases = [
  { alias:"骨盆", officialService:"骨盆调理" },
  { alias:"产后", officialService:"产后调理" },
  { alias:"整骨", officialService:"徒手体态调理" },
  { alias:"3D", officialService:"3D 小颜术" },
];
const promotions = [{
  name:"骨盆调理套餐", linkedService:"骨盆调理", sendOnPriceQuery:true,
  validFrom:"2026-10-01",validUntil:"2026-10-31",
  packages:[
    {name:"Package A",title:"尊享护理配套",imageUrl:"https://example.test/pelvic-a.jpg",
     caption:"本月限时优惠\nRM100 优惠券\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣"},
    {name:"Package B",title:"女性护理配套",imageUrl:"https://example.test/pelvic-b.jpg",
     caption:"本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣"},
  ],
}];
const resultMedia = [{
  enabled: true, service: "骨盆调理", relatedServices:["产后调理"],
}];
// Exact conversational shape: result media is sent between introduction and
// the assessment-price question; "产后体态" is an answer to the concern question.
const joey = [
  ["user","Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊"],
  ["assistant","我们的骨盆调理主要用徒手手法。中医师会先帮你做1对1的体态评估+体验。你目前主要在意小腹、腰臀酸紧，还是产后调理呢？"],
  ["assistant","这个是我们顾客护理后的 Before & After 😊"],
  ["assistant","再给你看一个顾客护理后的 Before & After 😊"],
  ["user","免费评估？"],
  ["assistant","是的，中医师的1对1体态评估+体验是完全免费的哦 😊 你平时主要是久坐腰酸、想改善小腹假胯宽，还是产后体态呢？"],
  ["user","产后体态"],
  ["assistant","了解～产后体态的话，中医师会一起看你的骨盆、腹部和整体状态。请问你目前生产完大概多久了呢？"],
  ["user","一年"],
  ["assistant","产后一年很适合安排来看看了。中医师会先帮你做一个1对1的体态评估+体验，看看目前的骨盆和体态恢复情况。"],
  ["user","一次疗程多少钱"],
].map(([role,content])=>({role,content}));
const current = joey.at(-1).content;
function args(conversationHistory=joey,customerText=current) {
  return {customerText,conversationHistory,services,serviceAliases,promotions,resultMedia,language:"zh"};
}
function recovery(extra={}) {
  return planInformationPriceRecovery({
    ...args(),flagged:true,reviewRequired:true,reviewType:"information",
    enabled:true,pendingClinicalReview:false,...extra,
  });
}
function withAssessmentFirst(callback) {
  const previous=config.automatedFollowUp;
  config.automatedFollowUp={...previous,assessmentFirstPricingEnabled:true,
    complimentaryAssessmentExperienceEnabled:true};
  return Promise.resolve().then(callback).finally(()=>{config.automatedFollowUp=previous});
}
test("Joey's full postpartum discussion resolves the earlier customer-named pelvic treatment",()=>{
  assert.equal(resolveVerifiedPriceFollowUpService(args())?.name,"骨盆调理");
  assert.match(recovery()?.reply || "",/Package A.*RM388/su);
  assert.match(recovery()?.reply || "",/Package B.*RM288/su);
  assert.match(recovery()?.reply || "",/优惠券后的价格/u);
  assert.doesNotMatch(recovery()?.reply || "",/RM100.*(?:off|折)/iu);
});

test("review recovery supplies verified response across old and new pricing paths",async()=>{
  await withAssessmentFirst(async()=>{
    const recovered=recovery();
    assert.equal(recovered?.treatment,"骨盆调理");
    const guarded=guardAssessmentFirstPricingReply({
      ...args(),reply:recovered.reply,treatment:recovered.treatment,
      flagged:false,requireVerifiedTreatment:true,
    });
    assert.equal(guarded.replaced,false);
    const legacy=ensureVerifiedPriceReply({...args(),
      reply:guarded.reply,treatment:recovered.treatment,
    });
    assert.match(legacy.reply,/RM388/u);
    assert.match(legacy.reply,/RM288/u);
    const d=resolveAiPricingDecision({
      ...args(),priceQuery:true,packageQuery:false,treatment:"产后调理",
    });
    assert.equal(d?.treatment,"骨盆调理");
    assert.equal(d?.source,"continued_customer");
    assert.deepEqual(d?.prices?.map(x=>x.price),["RM388","RM288"]);
    const graphics=await resolvePricePromotionForReply({
      ...args(),priceQuery:true,packageQuery:false,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      contactId:498,flagged:false,bookingReady:false,keywordReason:null,
      needsAttention:false,textSendSucceeded:true,
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.deepEqual(graphics?.packages?.map(x=>x.name),["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...args(),priceQuery:true,treatment:"骨盆调理",
      verifiedServiceFromText:"骨盆调理",contactId:498,
      textSendSucceeded:true,wasPromoRecentlySent:async()=>true,
      hasUnconfirmedMediaDelivery:async()=>false,
    }),null,"never resend after a previous confirmed promotion");
  });
});

test("clinical, staff, refusal, opt-out and uncertain information reviews remain blocked",()=>{
  for(const override of [
    {reviewType:"clinical"},{flagged:false},{reviewRequired:false},
    {enabled:false},{pendingClinicalReview:true},
    {hasKeywordAlert:true},{urgentSafety:true},{activeSafety:true},
    {explicitStaffRequest:true},{marketingStop:true},
  ]) assert.equal(recovery(override),null,JSON.stringify(override));
  const changes=[
    ["user","刚生产两周，想知道多少钱"],
    ["user","换去产后调理，多少钱"],
    ["user","价格太贵了"],
    ["user","我有糖尿病，一次疗程多少钱"],
    ["user","不用报价，一次疗程多少钱"],
  ];
  for(const [role,content] of changes) {
    const turns=[...joey.slice(0,-1),{role,content}];
    assert.equal(planInformationPriceRecovery({
      ...args(turns,content),flagged:true,reviewRequired:true,
      reviewType:"information",enabled:true,pendingClinicalReview:false,
    }),null,content);
  }
});
test("staff messages, treatment switches, ad-only history and unrelated messages never borrow pelvic pricing",()=>{
  const modified=[
    joey.slice(1),
    joey.map((t,i)=>i===9?{...t,content:"[Verified STAFF message] "+t.content}:t),
    [...joey.slice(0,6),{role:"user",content:"我现在想了解产后调理"},
      {role:"assistant",content:"骨盆调理也可以考虑"},{role:"user",content:"一年"},
      joey[9],joey[10]],
    [...joey.slice(0,8),{role:"user",content:"想先聊停车和地址"},
      {role:"assistant",content:"骨盆地址在PJ"},joey[10]],
    [...joey.slice(0,8),{role:"user",content:"不需要发优惠给我"},
      {role:"assistant",content:"骨盆相关已收到"},joey[10]],
    [joey[0],{role:"assistant",content:"骨盆调理介绍"},
      {role:"user",content:"产后调理是另外一项吗？"},
      {role:"assistant",content:"骨盆护理也可以先评估"},joey[10]],
  ];
  for(const turns of modified){
    assert.equal(resolveVerifiedPriceFollowUpService(args(turns,turns.at(-1).content)),null,
      JSON.stringify(turns.map(t=>t.content)));
  }
});
test("server checks informational review BEFORE early return and preserves safety preflight",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const recoveryPosition=server.indexOf("const recovered = planInformationPriceRecovery({");
  const earlyReturn=server.indexOf("if (flagged && reviewRequired) {");
  assert.ok(recoveryPosition>0&&earlyReturn>recoveryPosition);
  assert.match(server,/getTcmReviewEvidence\(\s*contact\.id,\s*savedInbound\.id\s*\)/u);
  assert.match(server,/pendingClinicalReview:\s*reviewEvidence\?\.pendingClinicalReview/u);
  assert.match(server,/if \(flagged && reviewRequired && reviewType === "information"/u);
});
