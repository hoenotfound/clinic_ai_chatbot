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
const { withPricingHistoryMetadata } = require("../src/utils/conversationStore");

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
].map(([role,content], i) => withPricingHistoryMetadata(
  {role,content},
  {role,created_at:new Date(Date.now() - 60_000 + i * 3_000),sent_by_username:null}
));
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
  assert.equal(resolveVerifiedPriceFollowUpService({...args(),allowContinuedPriceContext:true})?.name,"骨盆调理");
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
      flagged:false,requireVerifiedTreatment:true,allowContinuedPriceContext:true,
    });
    assert.equal(guarded.replaced,false);
    const legacy=ensureVerifiedPriceReply({...args(),
      reply:guarded.reply,treatment:recovered.treatment,
      allowContinuedPriceContext:true,
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
      aiPricingEnabled:true,pricingDecision:d,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      contactId:498,flagged:false,bookingReady:false,keywordReason:null,
      needsAttention:false,textSendSucceeded:true,
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.deepEqual(graphics?.packages?.map(x=>x.name),["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...args(),priceQuery:true,treatment:"骨盆调理",
      aiPricingEnabled:true,pricingDecision:d,
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
    assert.equal(resolveVerifiedPriceFollowUpService({
      ...args(turns,turns.at(-1).content),allowContinuedPriceContext:true,
    }),null,
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
  assert.match(server,/if \(aiPricingEnabled &&\s*flagged && reviewRequired && reviewType === "information"/u);
});


test("realistic image-bearing assistant captions preserve customer treatment but staff media blocks",()=>{
  const { pricingMessageText, isVerifiedStaffTurn } =
    require("../src/utils/priceFollowUpContext");
  const media = withPricingHistoryMetadata(
    {role:"assistant",content:[
      {type:"text",text:joey[3].content},
      {type:"image",mimeType:"image/jpeg",data:"ignored-test-image-bytes"},
    ]},
    {role:"assistant",created_at:new Date(joey[3].pricingCreatedAtMs)}
  );
  assert.equal(pricingMessageText(media),joey[3].content);
  const legit=[...joey.slice(0,3),media,...joey.slice(4)];
  assert.equal(resolveVerifiedPriceFollowUpService({
    ...args(legit),allowContinuedPriceContext:true,
  })?.name,"骨盆调理");
  const staffImage = withPricingHistoryMetadata(
    {role:"assistant",content:[
      {type:"text",text:"骨盆护理优惠内容"},
      {type:"image",mimeType:"image/png",data:"ignored-image-bytes"},
    ]},
    {role:"assistant",created_at:new Date(joey[3].pricingCreatedAtMs),sent_by_username:"admin"}
  );
  assert.equal(isVerifiedStaffTurn(staffImage),true);
  const blocked=[...joey.slice(0,3),staffImage,...joey.slice(4)];
  assert.equal(resolveVerifiedPriceFollowUpService({
    ...args(blocked),allowContinuedPriceContext:true,
  }),null,"authenticated staff attachment is a hard barrier");
  const prefixOnly = withPricingHistoryMetadata(
    {role:"assistant",content:[
      {type:"text",text:"[Verified STAFF message] 骨盆优惠介绍"},
      {type:"image",mimeType:"image/jpeg",data:"ignored"},
    ]},
    {role:"assistant",created_at:new Date(joey[3].pricingCreatedAtMs)}
  );
  assert.equal(isVerifiedStaffTurn(prefixOnly),true);
  assert.equal(resolveVerifiedPriceFollowUpService({
    ...args([...joey.slice(0,3),prefixOnly,...joey.slice(4)]),
    allowContinuedPriceContext:true,
  }),null,"staff prefix in structured text must also block");
});

test("only fresh, monotonic trusted timestamps authorize extended price carryover",()=>{
  const { resolveContinuedTreatmentPriceService } =
    require("../src/utils/priceFollowUpContext");
  const cloneWithOffsets=(offsets) => joey.map((row,i)=>withPricingHistoryMetadata(
    {role:row.role,content:row.content},
    {role:row.role,created_at:new Date(Date.now()+offsets[i]),sent_by_username:null}
  ));
  assert.equal(resolveContinuedTreatmentPriceService(args())?.name,"骨盆调理");
  const old=cloneWithOffsets(joey.map((_,i)=> -26*60*60*1000+i*5_000));
  assert.equal(resolveContinuedTreatmentPriceService(args(old)),null,"day-old discussion is not permission");
  const extended=cloneWithOffsets(joey.map((_,i)=> i===0?-26*60*60*1000:
    -60_000+i*3_000));
  assert.equal(resolveContinuedTreatmentPriceService(args(extended)),null,
    "stale customer service anchor must block even when latest replies are recent");
  const unordered=cloneWithOffsets(joey.map((_,i)=>-60_000+i*3_000));
  const reTimed=withPricingHistoryMetadata(
    {role:unordered[4].role,content:unordered[4].content},
    {role:"user",created_at:new Date(Date.now()-65_000)}
  );
  unordered[4]=reTimed;
  assert.equal(resolveContinuedTreatmentPriceService(args(unordered)),null,
    "out-of-order timestamps invalidate context");
  const withoutTime=joey.map(x=>({role:x.role,content:x.content}));
  assert.equal(resolveContinuedTreatmentPriceService(args(withoutTime)),null,
    "missing trustworthy metadata must fail closed");
});

test("deployment setting can shorten the price-context window, never extend it beyond 24 hours",()=>{
  const { resolveContinuedTreatmentPriceService } =
    require("../src/utils/priceFollowUpContext");
  const variable = "AI_PRICING_CONTINUITY_MAX_AGE_HOURS";
  const previous = process.env[variable];
  const pastThread=(hours)=>joey.map((turn,i)=>withPricingHistoryMetadata(
    {role:turn.role,content:turn.content},
    {role:turn.role,created_at:new Date(Date.now()-hours*60*60*1000+i*3_000)}
  ));
  try {
    const twoHoursOld = pastThread(2);
    const twentySixHoursOld = pastThread(26);
    process.env[variable] = "1";
    assert.equal(resolveContinuedTreatmentPriceService(args(twoHoursOld)),null,
      "one-hour setting cannot revive a two-hour-old conversation");
    assert.equal(resolveContinuedTreatmentPriceService(args())?.name,"骨盆调理",
      "fresh conversations remain usable");
    process.env[variable] = "24";
    assert.equal(resolveContinuedTreatmentPriceService(args(twoHoursOld))?.name,"骨盆调理",
      "the default 24-hour window remains available");
    process.env[variable] = "72";
    assert.equal(resolveContinuedTreatmentPriceService(args(twentySixHoursOld)),null,
      "oversized overrides must not widen the verified window");
    process.env[variable] = "invalid";
    assert.equal(resolveContinuedTreatmentPriceService(args(twentySixHoursOld)),null,
      "invalid overrides must also remain fail-closed");
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("Postgres evidence fields stay readable to pricing logic but invisible to model JSON",()=>{
  const row={role:"assistant",content:[{type:"text",text:"Hello"},{type:"image",data:"fake"}]};
  const enriched=withPricingHistoryMetadata(row,{
    role:"assistant",created_at:new Date(),sent_by_username:"admin"
  });
  assert.equal(enriched.pricingStaffAuthored,true);
  assert.ok(Number.isFinite(enriched.pricingCreatedAtMs));
  assert.equal(Object.keys(enriched).includes("pricingCreatedAtMs"),false);
  assert.equal(Object.keys(enriched).includes("pricingStaffAuthored"),false);
  assert.deepEqual(JSON.parse(JSON.stringify(enriched)),row);
  assert.equal(withPricingHistoryMetadata({role:"user",content:"hi"},{
    role:"user",created_at:"invalid-time"
  }).pricingCreatedAtMs,null);
});

test("Off and Shadow cannot activate extended pricing or the review-gate bypass",()=>{
  const input=args();
  assert.equal(resolveVerifiedPriceFollowUpService(input),null,
    "legacy service resolver must not carry long postpartum assessment thread");
  const oldGuard=guardAssessmentFirstPricingReply({
    ...input,reply:"Package A RM388, Package B RM288",
    treatment:"骨盆调理",requireVerifiedTreatment:true,
  });
  assert.equal(oldGuard.replaced,true,"legacy related-treatment guard remains unchanged");
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(server,/if \(aiPricingEnabled &&\s*flagged && reviewRequired && reviewType === "information"/u);
  assert.match(server,/allowContinuedPriceContext: aiPricingEnabled/u);
  assert.match(server,/const aiPricingEnabled = aiPricingMode === "enabled"/u);
});
