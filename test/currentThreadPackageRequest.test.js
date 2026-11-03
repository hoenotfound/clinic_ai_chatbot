"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config/clinicConfig");
const { withPricingHistoryMetadata } = require("../src/utils/conversationStore");
const { resolveCurrentThreadPackageRequest } =
  require("../src/utils/scopedPackagePriceContinuation");
const { resolveApprovedPricingAssessment } =
  require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } =
  require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } =
  require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "骨盆调理" },
  { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" },
  { name: "徒手体态调理" },
];
const aliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "整骨", officialService: "徒手体态调理" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理",
  sendOnPriceQuery: true, validFrom: "2026-10-01", validUntil: "2099-12-31",
  packages: [
    { name: "Package A", title: "尊享护理配套",
      imageUrl: "https://example.test/pelvic-a.jpg",
      caption: "本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣" },
    { name: "Package B", title: "女性护理配套",
      imageUrl: "https://example.test/pelvic-b.jpg",
      caption: "本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣" },
  ],
}, {
  name: "3D First Trial", linkedService: "3D 小颜术",
  sendOnPriceQuery: true, validFrom: "2026-10-01", validUntil: "2099-12-31",
  imageUrl: "https://example.test/3d.jpg",
  caption: "限时优惠 只需 RM488 原价 RM888",
}];

const jessica = [
  ["user", "Hi, may I know what's the charges?"],
  ["assistant", "Hi hello 👋 Welcome to Neutro Sense TCM～ Are you looking to check the charges for our body/pelvic posture conditioning, or our facial treatments like 3D or 9D?"],
  ["user", "Lower back discomfort or pain\nMuscle tightness around my right hips"],
  ["assistant", "Our TCM practitioner will first do a 1-to-1 posture assessment + introductory experience before advising on a plan."],
  ["user", "Quite a while ago"],
  ["assistant", "For your pelvic and hip balance, would you prefer a weekday or weekend assessment?"],
  ["user", "I need to know what will be the charges"],
  ["assistant", "Which treatment would you like the price for? I can help you check 😊"],
  ["user", "Roughly. Any package?"],
  ["assistant", "有的哦～我们骨盆调理目前有相关的配套选择，"],
  ["user", "Could you please share"],
];

function makeInput(overrides = {}) {
  const now = Date.now();
  const source = overrides.turns || jessica;
  const conversationHistory = source.map(([role,content],index) => {
    const sentBy = /^"?"\[Verified STAFF message\]/u.test(content)
      ? "admin" : null;
    const row = {
      role, created_at:new Date(now - (source.length-index)*5000),
      sent_by_username:sentBy,is_automated_follow_up:false,
    };
    return withPricingHistoryMetadata({role,content},row);
  });
  return {
    customerText:source.at(-1)?.[1],
    conversationHistory, services, serviceAliases:aliases, promotions, now,
    ...overrides,
    // Tests may override the turns or timestamps, but all cases use real DB
    // metadata format, not artificial AI-authored time claims.
    ...(overrides.conversationHistory ? {} : {conversationHistory}),
  };
}

function resolve(overrides={}) {
  return resolveCurrentThreadPackageRequest(makeInput(overrides));
}

test("Jessica: current-thread accepted pelvic package offer produces independently verified RM388/RM288",async()=>{
  const request = makeInput();
  const candidate = resolveCurrentThreadPackageRequest(request);
  assert.equal(candidate?.source,"confirmed_current_thread_package_offer");
  assert.equal(candidate?.treatment,"骨盆调理");
  assert.deepEqual(candidate?.prices?.map(x=>x.price),["RM388","RM288"]);
  const approval = resolveApprovedPricingAssessment({
    mode:"shadow", scopedPackageDecision:candidate,
    customerText:request.customerText, conversationHistory:request.conversationHistory,
    services,serviceAliases:aliases,resultMedia:[],
  });
  assert.equal(approval.reason,"approved");
  const original = config.automatedFollowUp;
  config.automatedFollowUp={...original,assessmentFirstPricingEnabled:true};
  try {
    const quoted=ensureVerifiedPriceReply({
      ...request, reply:"Our pelvic conditioning packages currently available are:\n\n\n",
      pricingDecision:approval.decision,
      treatment:"骨盆调理",clarifiedPriceService:"骨盆调理",
      priceOnlyResponse:true,language:"en",resultMedia:[],
    });
    assert.equal(quoted.restored,true);
    assert.match(quoted.reply,/Package A[\s\S]*RM388/u);
    assert.match(quoted.reply,/Package B[\s\S]*RM288/u);
    assert.doesNotMatch(quoted.reply,/currently available are:\s*(?:\n|$)/iu);
    assert.doesNotMatch(quoted.reply,/3D|9D|RM688/u);
    const options = {
      ...request, pricingDecision:approval.decision,
      aiPricingEnabled:true,priceQuery:false,packageQuery:false,
      treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
      language:"en",contactId:8907,flagged:false,bookingReady:false,
      keywordReason:null,needsAttention:false,textSendSucceeded:true,
      resultMedia:[],wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    };
    const images=await resolvePricePromotionForReply(options);
    assert.deepEqual(images?.packages?.map(x=>x.name),["Package A","Package B"]);
    assert.deepEqual(images?.packages?.map(x=>x.imageUrl),[
      "https://example.test/pelvic-a.jpg","https://example.test/pelvic-b.jpg",
    ]);
    assert.equal(await resolvePricePromotionForReply({
      ...options,wasPromoRecentlySent:async()=>true,
    }),null,"a staff-delivered recent promo must prevent duplicates");
    assert.equal(await resolvePricePromotionForReply({
      ...options,hasUnconfirmedMediaDelivery:async()=>true,
    }),null,"unconfirmed media must prevent a repeated send");
    assert.equal(await resolvePricePromotionForReply({
      ...options,needsAttention:true,
    }),null,"staff review stops images");
  } finally {config.automatedFollowUp=original;}
});

test("current package acceptance requires the immediately preceding single-service offer and price enquiry",()=>{
  for(const [label,turns] of [
    ["no offered package",jessica.slice(0,-2).concat([
      ["assistant","We can arrange a free posture assessment."],["user","Could you please share"]])],
    ["multiple offered services",jessica.slice(0,-2).concat([
      ["assistant","We have 骨盆调理 and 3D 小颜术 packages."],["user","Could you please share"]])],
    ["no prior price request",jessica.slice(0,-3).concat([
      ["user","I can come on Tuesday"],["assistant","We have 骨盆调理 packages."],["user","Could you please share"]])],
    ["customer changed service",jessica.slice(0,-3).concat([
      ["user","Please send 3D pricing"],["assistant","We have 骨盆调理 packages."],["user","Could you please share"]])],
    ["prior selected 3D",jessica.slice(0,2).concat([
      ["user","I'm interested in 3D"],...jessica.slice(3)])],
    ["staff stepped in",jessica.slice(0,-2).concat([
      ["assistant","[Verified STAFF message] We have 骨盆调理 packages."],["user","Could you please share"]])],
    ["no acceptance",jessica.slice(0,-1).concat([
      ["user","I want 9D treatment instead"]])],
    ["broad clinic request",jessica.slice(0,-1).concat([
      ["user","Send me all clinic services and their full price list"]])],
    ["refusal",jessica.slice(0,-1).concat([["user","Don't send promotions"]])],
  ]) {
    assert.equal(resolve({turns}),null,label);
  }
});

test("stale, untrusted, contradictory and unavailable pricing never authorize media",()=>{
  const source=makeInput();
  const stale=source.conversationHistory.map(t=>({
    ...t,pricingCreatedAtMs:t.pricingCreatedAtMs-25*3600_000,
  }));
  assert.equal(resolve({conversationHistory:stale}),null);
  const withoutTime=source.conversationHistory.map(({pricingCreatedAtMs,...t})=>t);
  assert.equal(resolve({conversationHistory:withoutTime}),null);
  assert.equal(resolve({promotions:promotions.slice(1)}),null);
  const conflict=promotions.map(p=>p.linkedService==="骨盆调理"
    ? {...p,packages:p.packages.map(pkg=>pkg.name==="Package A"
      ? {...pkg,caption:"优惠后仅需 RM399",
        followUpTranslations:{zh:"优惠后仅需 RM388"}}:pkg)}:p);
  assert.equal(resolve({promotions:conflict}),null);
  const repeated=promotions.map(p=>p.linkedService==="骨盆调理"
    ? {...p,name:"another current pelvic campaign"}:p);
  assert.equal(resolve({promotions:[...promotions,...repeated]}),null);
});

test("server routes this proof through existing Shadow approval, text and promo media gates",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const verify=server.indexOf("scopedPackagePrice = resolveCurrentThreadPackageRequest(");
  const review=server.indexOf("if (scopedPackagePrice && scopedReviewCandidate)",verify);
  const approval=server.indexOf("const pricingApproval = resolveApprovedPricingAssessment(",verify);
  const media=server.indexOf("const promoBundle =",approval);
  assert.ok(verify>0 && verify<review && review<approval && approval<media);
  assert.match(server,/exceptionalPricingCandidate = Boolean\([\s\S]{0,200}scopedPackagePrice/);
  assert.match(server,/pricingDecision: comboMediaPricingDecision \|\|[\s\S]{0,160}approvedPricingDecision/);
  assert.match(server,/secondaryAiMediaQueue/);
});
