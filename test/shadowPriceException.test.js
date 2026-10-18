"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const clinicConfig = require("../src/config/clinicConfig");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolvePricePromotionForReply, selectPromoDuplicateCheck } = require("../src/utils/pricePromotionTrigger");
const {
  wasPromoRecentlySentWithExecutor, wasMediaRecentlySentWithExecutor,
} = require("../src/db/messagesRepo");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");

const now = Date.now();
const services = [{ name:"骨盆调理" }, { name:"徒手体态调理" }, { name:"3D 小颜术" }];
const serviceAliases = [
  { alias:"骨盆", officialService:"骨盆调理" },
  { alias:"3D", officialService:"3D 小颜术" },
];
const promotions = [{
  name:"骨盆调理套餐", linkedService:"骨盆调理", sendOnPriceQuery:true,
  validFrom:"2000-01-01", validUntil:"2999-12-31",
  packages:[
    { name:"Package A", title:"尊享护理配套", imageUrl:"https://example.test/a.jpg",
      caption:"RM100 优惠券，原价 RM488，优惠后仅需 RM388" },
    { name:"Package B", title:"女性护理配套", imageUrl:"https://example.test/b.jpg",
      caption:"原价 RM388，现在只需 RM288" },
  ],
}];
const context = {
  serviceHint:"骨盆调理", serviceHintSource:"ad_name",
  headline:"骨盆矫正", body:"徒手矫正",
  attributedAt:new Date(now - 40_000).toISOString(),
};
const turn = (role, content, age = 0, staff = false) => ({
  role, content, pricingCreatedAtMs:now - age, pricingStaffAuthored:staff,
});
const freshAdHistory = () => [
  turn("user", "Hi～", 35_000),
  turn("assistant", "Hi! 欢迎了解 😊", 28_000),
  turn("user", "多少钱？", 15_000),
];
const parameters = (overrides = {}) => ({
  customerText:"多少钱？", conversationHistory:freshAdHistory(),
  metaAdContext:context, services, serviceAliases, promotions,
  complimentaryAssessmentExperienceEnabled:true, now, ...overrides,
});
const price = overrides => resolveShadowPriceException(parameters(overrides));
async function withAssessmentFirst(callback) {
  const old = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {
    ...old, assessmentFirstPricingEnabled:true,
    complimentaryAssessmentExperienceEnabled:true,
  };
  try { return await callback(); }
  finally { clinicConfig.automatedFollowUp = old; }
}

test("Shadow: recent verified 骨盆 ad plus short price question selects correct active packages", async () => {
  const decision = price();
  assert.equal(decision?.source, "meta_ad");
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices.map(x => x.price), ["RM388", "RM288"]);
  await withAssessmentFirst(async () => {
    const formatted = ensureVerifiedPriceReply({
      ...parameters(), reply:"想了解哪个服务呢？",
      treatment:decision.treatment,
      clarifiedPriceService:decision.treatment,
      priceOnlyResponse:true, language:"zh",
    });
    assert.match(formatted.reply, /Package A.*RM388/su);
    assert.match(formatted.reply, /Package B.*RM288/su);
    const bundle = await resolvePricePromotionForReply({
      ...parameters(), priceQuery:true, packageQuery:false,
      aiPricingEnabled:false, treatment:decision.treatment,
      verifiedServiceFromText:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      flagged:false, bookingReady:false, keywordReason:null,
      needsAttention:false, textSendSucceeded:true, contactId:47, language:"zh",
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.deepEqual(bundle?.packages.map(x=>x.name), ["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...parameters(), priceQuery:true, aiPricingEnabled:false,
      treatment:decision.treatment, verifiedServiceFromText:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      flagged:false, bookingReady:false, keywordReason:null,
      needsAttention:false, textSendSucceeded:true, contactId:47,
      wasPromoRecentlySent:async()=>true,
      hasUnconfirmedMediaDelivery:async()=>false,
    }), null, "previously sent graphics cannot be repeated");
  });
});

test("Shadow: initial explicit customer treatment then direct session-fee question remains narrow", () => {
  const history = [
    turn("user", "Hi～我对骨盆调理有兴趣", 60_000),
    turn("assistant", "骨盆调理主要是徒手调理", 50_000),
    turn("assistant", "给你看看我们的 Before & After", 45_000),
    turn("user", "请问一次收费是多少呢", 20_000),
  ];
  const decision = resolveShadowPriceException(parameters({
    customerText:"请问一次收费是多少呢", conversationHistory:history,
    metaAdContext:null,
  }));
  assert.equal(decision?.source, "recent_first_customer");
  assert.deepEqual(decision?.prices.map(p=>p.price), ["RM388","RM288"]);
  assert.equal(price({metaAdContext:null}), null, "a generic greeting alone must not select pelvic");
});

test("Shadow remains fail-closed for stale, ambiguous, clinical and staff cases", () => {
  const old = { ...context, attributedAt:new Date(now - 9*86400_000).toISOString() };
  assert.equal(price({metaAdContext:old}), null);
  assert.equal(price({metaAdContext:null}), null);
  assert.equal(price({metaAdContext:{...context, serviceHint:null}}), null);
  assert.equal(price({metaAdContext:{...context, serviceHintSource:null}}), null);
  assert.equal(price({promotions:[]}), null);
  assert.equal(price({customerText:"Hi",conversationHistory:[
    turn("user","Hi",15_000),
  ]}), null);
  assert.equal(price({customerText:"所有疗程多少钱？",conversationHistory:[
    turn("user","Hi",35_000),turn("assistant","Hi",25_000),
    turn("user","所有疗程多少钱？",15_000),
  ]}), null);
  assert.equal(price({customerText:"我觉得太贵了",conversationHistory:[
    turn("user","Hi",35_000),turn("assistant","Hi",25_000),
    turn("user","我觉得太贵了",15_000),
  ]}), null);
  assert.equal(price({customerText:"免费评估收费吗？",conversationHistory:[
    turn("user","Hi",35_000),turn("assistant","Hi",25_000),
    turn("user","免费评估收费吗？",15_000),
  ]}), null);
  assert.equal(price({customerText:"我有糖尿病，骨盆调理多少钱？",conversationHistory:[
    turn("user","Hi",35_000),turn("assistant","Hi",25_000),
    turn("user","我有糖尿病，骨盆调理多少钱？",15_000),
  ]}), null);
  const switched = [
    turn("user","我想了解3D 小颜术",35_000),
    turn("assistant","3D 小颜术可以介绍",25_000),
    turn("user","多少钱？",15_000),
  ];
  assert.equal(price({conversationHistory:switched}), null);
  const staff = [
    turn("user","Hi",35_000),
    turn("assistant", [{type:"text",text:"人工已回复"},{type:"image",data:"test"}],25_000,true),
    turn("user","多少钱？",15_000),
  ];
  assert.equal(price({conversationHistory:staff}), null);
  const staffPrefix = [
    turn("user","Hi",35_000),
    turn("assistant", [{type:"text",text:"[Verified STAFF message] Hi"},{type:"image",data:"test"}],25_000),
    turn("user","多少钱？",15_000),
  ];
  assert.equal(price({conversationHistory:staffPrefix}), null);
});

test("Shadow informational review is gated by staff/safety and live clinical-review evidence", () => {
  const source = fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(source,/if \(shadowPriceException && flagged && reviewRequired &&\s*reviewType === "information"\)/u);
  assert.match(source,/reviewEvidence\?\.pendingClinicalReview === false/u);
  assert.match(source,/!keywordReason && !urgentSafety && !isActiveSafetyConcern\(text\)/u);
  assert.match(source,/!isExplicitStaffRequest\(text\) && !marketingStopQuestion/u);
  assert.match(source,/const shadowPriceException = aiPricingMode === "shadow"/u);
  assert.match(source,/verifiedShadowPriceService: pricingAuthorityRequired/u);
  assert.match(source,/approvedPricingDecision && shadowPriceException/u);
  assert.match(source,/priceOnlyResponse: pricingAuthorityRequired/u);
  assert.match(source,/Boolean\(approvedPricingDecision && exceptionalPricingCandidate\)/u);
});


test("PR #352 verified price graphics deduplicate manual sends despite different captions", async () => {
  // Reproduce a staff-accepted image where the shop updated its caption
  // AFTER the media was already delivered. The exact same picture must not
  // be sent again within the existing 24-hour duplicate window.
  const rows = [
    { contactId:47, imageUrl:"https://example.test/a.jpg",
      caption:"Older caption manually sent by admin", accepted:true },
  ];
  const executor = {
    query: async (sql, args) => {
      const [contactId, imageUrl] = args;
      const checksCaption = /content\s*=\s*\$3/u.test(sql);
      return {
        rowCount: rows.filter(row => row.accepted &&
          row.contactId === contactId && row.imageUrl === imageUrl &&
          (!checksCaption || row.caption === args[2])).length,
      };
    },
  };
  const newCaption = "New caption from the October promotion";
  const oldCheck = (id,url,caption,hours) =>
    wasPromoRecentlySentWithExecutor(executor,id,url,caption,hours);
  const identityCheck = (id,url,hours) =>
    wasMediaRecentlySentWithExecutor(executor,id,url,hours);
  assert.equal(await oldCheck(47,"https://example.test/a.jpg",newCaption,24),false,
    "legacy image-and-caption check misses a manual send with older caption");
  assert.equal(await identityCheck(47,"https://example.test/a.jpg",24),true,
    "media identity check finds the same accepted image");

  const messagesRepo = {
    wasPromoRecentlySent:oldCheck,
    wasMediaRecentlySent:identityCheck,
  };
  for (const trusted of [
    { aiPricingEnabled:true },
    { shadowPriceException:{ treatment:"骨盆调理" } },
    { numberedPricingSelection:{ treatment:"骨盆调理" } },
    { scopedPackagePrice:{ treatment:"骨盆调理" } },
  ]) {
    const check = selectPromoDuplicateCheck({ ...trusted, messagesRepo });
    assert.equal(await check(47,"https://example.test/a.jpg",newCaption,24),true,
      "verified price flow must block previously sent graphic: " +
       JSON.stringify(Object.keys(trusted)));
  }
  const legacy = selectPromoDuplicateCheck({ messagesRepo });
  assert.equal(await legacy(47,"https://example.test/a.jpg",newCaption,24),false,
    "unmodified legacy media rules retain their prior behaviour");

  await withAssessmentFirst(async () => {
    const decision = price();
    const check = selectPromoDuplicateCheck({
      shadowPriceException:decision, messagesRepo,
    });
    const result = await resolvePricePromotionForReply({
      ...parameters(), priceQuery:true, packageQuery:false,
      aiPricingEnabled:false, treatment:decision.treatment,
      verifiedServiceFromText:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      flagged:false, bookingReady:false, keywordReason:null,
      needsAttention:false, textSendSucceeded:true,
      contactId:47, language:"zh",
      wasPromoRecentlySent:check,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.deepEqual(result?.packages.map(p=>p.name), ["Package B"],
      "an already-sent Package A must be suppressed while eligible unsent B remains");
    rows.push({contactId:47,imageUrl:"https://example.test/b.jpg",
      caption:"Another outdated manually sent caption",accepted:true});
    const bothSent = await resolvePricePromotionForReply({
      ...parameters(), priceQuery:true, packageQuery:false,
      aiPricingEnabled:false, treatment:decision.treatment,
      verifiedServiceFromText:decision.treatment,
      verifiedShadowPriceService:decision.treatment,
      flagged:false, bookingReady:false, keywordReason:null,
      needsAttention:false, textSendSucceeded:true,
      contactId:47, language:"zh",
      wasPromoRecentlySent:check,
      hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(bothSent,null,
      "neither Package A nor B should repeat after both were sent manually");
  });
});

test("media identity duplicate check is used in server's final outbound send path", () => {
  const source = fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(source,/wasPromoRecentlySent:\s*selectPromoDuplicateCheck\(\{/u);
  assert.match(source,/aiPricingEnabled: pricingAuthorityRequired/u);
  assert.match(source,/numberedPricingSelection: pricingAuthorityRequired/u);
  assert.match(source,/shadowPriceException: pricingAuthorityRequired/u);
  assert.match(source,/scopedPackagePrice: pricingAuthorityRequired/u);
  assert.match(source,/messagesRepo,/u);
  assert.match(source,/hasUnconfirmedMediaDelivery:\s*messagesRepo\.hasUnconfirmedMediaDelivery/u);
});


test("Malaysian Chinese ad-linked monetary questions authorize exactly current pelvic prices",()=>{
  const { resolveAiPricingDecision }=require("../src/utils/aiPricingIntentDecision");
  const { resolveApprovedPricingAssessment }=require("../src/utils/approvedPricingDecision");
  for (const text of ["什么价钱呢？","想了解是什么价钱先呢？","价钱呢？"]) {
    const customerHistory=[
      turn("user","Hi～",35_000),
      turn("assistant","Hi! 欢迎了解 😊",28_000),
      turn("user",text,15_000),
    ];
    const shadow=price({customerText:text,conversationHistory:customerHistory});
    assert.equal(shadow?.source,"meta_ad",text);
    assert.equal(shadow?.treatment,"骨盆调理",text);
    assert.deepEqual(shadow?.prices?.map(p=>p.price),["RM388","RM288"],text);
    const enabled=resolveAiPricingDecision({
      priceQuery:true,packageQuery:false,treatment:null,
      customerText:text,conversationHistory:customerHistory,
      services,serviceAliases,promotions,metaAdContext:context,
      complimentaryAssessmentExperienceEnabled:true,now,
    });
    assert.equal(enabled?.source,"meta_ad",text);
    assert.equal(resolveApprovedPricingAssessment({
      mode:"enabled",aiDecision:enabled,customerText:text,
      conversationHistory:customerHistory,services,serviceAliases,
      resultMedia:[],now,
    }).reason,"approved",text);
  }
});

test("ad-only phrase broadening cannot quote fees, objections, stale ads or switched treatments",()=>{
  const { resolveAiPricingDecision }=require("../src/utils/aiPricingIntentDecision");
  const negatives=[
    "价钱太贵了？","我不想了解价钱呢？",
    "免费评估收费吗？","预约费多少钱？",
    "其他疗程什么价钱呢？",
  ];
  for(const text of negatives){
    const history=[
      turn("user","Hi～",35_000),
      turn("assistant","Hi! 欢迎了解 😊",28_000),
      turn("user",text,15_000),
    ];
    assert.equal(price({customerText:text,conversationHistory:history}),null,text);
    assert.equal(resolveAiPricingDecision({
      priceQuery:true,customerText:text,conversationHistory:history,
      services,serviceAliases,promotions,metaAdContext:context,
      complimentaryAssessmentExperienceEnabled:true,now,
    }),null,text);
  }
  const stale={...context,attributedAt:new Date(now-8*86400_000).toISOString()};
  const history=[turn("user","Hi～",35_000),
    turn("assistant","Hi",28_000),
    turn("user","什么价钱呢？",15_000)];
  assert.equal(price({customerText:"什么价钱呢？",conversationHistory:history,
    metaAdContext:stale}),null);
});
