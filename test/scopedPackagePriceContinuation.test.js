"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { resolveScopedPackagePriceContinuation } =
  require("../src/utils/scopedPackagePriceContinuation");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");

const services = [
  { name: "骨盆调理" }, { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" }, { name: "徒手体态调理" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "整骨", officialService: "徒手体态调理" },
];
const promotions = [
  { name: "骨盆调理套餐", linkedService: "骨盆调理",
    sendOnPriceQuery: true, validFrom: "2026-10-01", validUntil: "2026-10-31",
    packages: [
      { name: "Package A", title: "尊享护理配套",
        imageUrl: "https://example.test/pelvic-a.jpg",
        caption: "本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣" },
      { name: "Package B", title: "女性护理配套",
        imageUrl: "https://example.test/pelvic-b.jpg",
        caption: "本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣" },
    ],
  },
  { name: "3D First Trial",linkedService: "3D 小颜术",sendOnPriceQuery:true,
    imageUrl:"https://example.test/3d.jpg",caption:"只需 RM488 原价 RM888",
    pricing:{currency:"MYR",offer:488,normal:888} },
];
const ad = () => ({
  // The current lead's attributed Meta creative can be general "整骨".
  // Do not use an inferred service label: the CUSTOMER named 骨盆调理.
  headline:"徒手整骨｜从头到脚",
  body:"今天来了一位小姐姐做骨盆矫正评估",
  attributedAt:new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
});
const initial = "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊";
const price = "价钱这方面";
const clarification = "请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊";
const current = "每一项都想了解";
const history = [
  { role:"user", content:initial },
  { role:"assistant", content:"中医师会先帮你做1对1体态评估+体验，了解你的骨盆和体态状况哦 😊" },
  { role:"assistant", content:"Before & After 😊" },
  { role:"assistant", content:"Hi～很多平时久坐上班的顾客做完骨盆调理后都觉得状态轻松" },
  { role:"user", content:price },
  { role:"assistant", content:clarification },
  { role:"user", content:current },
];
function input(overrides = {}) {
  return {customerText:current,conversationHistory:history,
    metaAdContext:ad(),services,serviceAliases,promotions,...overrides};
}
function decision(overrides = {}) {
  return resolveScopedPackagePriceContinuation(input(overrides));
}
async function priceMedia(overrides = {}) {
  return resolvePricePromotionForReply({
    ...input(),
    priceQuery:false,packageQuery:false,
    aiPricingEnabled:false,pricingDecision:null,
    treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
    resultMedia:[],language:"zh",contactId:493,
    flagged:false,keywordReason:null,bookingReady:false,needsAttention:false,
    textSendSucceeded:true,wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
    ...overrides,
  });
}

test("骨盆 ad + explicit customer choice + price clarification + every item means ONLY both pelvic prices", async()=>{
  const d=decision();
  assert.equal(d?.treatment,"骨盆调理");
  assert.equal(d?.source,"customer_scoped_packages");
  assert.deepEqual(d?.prices?.map(x=>x.price),["RM388","RM288"]);
  assert.deepEqual(d?.prices?.map(x=>x.name),["Package A","Package B"]);
  await withAssessmentFirst(async()=>{
    const guarded=guardAssessmentFirstPricingReply({
      ...input(),reply:"这个要怎么安排呢？",treatment:d.treatment,
      clarifiedPriceService:d.clarifiedPriceService,requireVerifiedTreatment:true,
      resultMedia:[],
    });
    assert.equal(guarded.replaced,false);
    const reply=ensureVerifiedPriceReply({
      ...input(), reply:guarded.reply,treatment:d.treatment,
      clarifiedPriceService:d.clarifiedPriceService,resultMedia:[],language:"zh",
    });
    assert.equal(reply.restored,true);
    assert.match(reply.reply,/Package A.*RM388/su);
    assert.match(reply.reply,/Package B.*RM288/su);
    assert.doesNotMatch(reply.reply,/3D|9D|RM688/u);
    assert.match(reply.reply,/优惠券后的价格/u);
    const media=await priceMedia();
    assert.deepEqual(media?.packages.map(x=>x.name),["Package A","Package B"]);
    assert.deepEqual(media?.packages.map(x=>x.imageUrl),[
      "https://example.test/pelvic-a.jpg","https://example.test/pelvic-b.jpg",
    ]);
    assert.equal(await priceMedia({wasPromoRecentlySent:async()=>true}),null);
    assert.equal(await priceMedia({hasUnconfirmedMediaDelivery:async()=>true}),null);
    assert.equal(await priceMedia({textSendSucceeded:false}),null);
    assert.equal(await priceMedia({needsAttention:true}),null);
  });
});
async function withAssessmentFirst(fn) {
  const original = config.automatedFollowUp;
  config.automatedFollowUp = {...original, assessmentFirstPricingEnabled:true};
  try { return await fn(); } finally { config.automatedFollowUp = original; }
}

test("first '价钱这方面' after pelvic ad should already quote both packages without asking which treatment",async()=>{
  const currentPrice="价钱这方面";
  const firstPriceHistory=[...history.slice(0,-3),{role:"user",content:currentPrice}];
  const d=decision({customerText:currentPrice,conversationHistory:firstPriceHistory});
  assert.equal(d?.treatment,"骨盆调理");
  assert.deepEqual(d?.prices?.map(x=>x.price),["RM388","RM288"]);
  await withAssessmentFirst(async()=>{
    const quoted=ensureVerifiedPriceReply({
      ...input({customerText:currentPrice,conversationHistory:firstPriceHistory}),
      reply:"你想先了解哪一项呢？",treatment:d.treatment,
      clarifiedPriceService:d.clarifiedPriceService,resultMedia:[],language:"zh",
    });
    assert.equal(quoted.restored,true);
    assert.match(quoted.reply,/Package A.*RM388/su);
    assert.match(quoted.reply,/Package B.*RM288/su);
    assert.doesNotMatch(quoted.reply,/3D|9D|RM688/u);
    const media=await priceMedia({customerText:currentPrice,conversationHistory:firstPriceHistory});
    assert.deepEqual(media?.packages?.map(x=>x.name),["Package A","Package B"]);
  });
});

test("don't infer from ad or bot label alone, a broad clinic price list, a switched treatment or expired ads",()=>{
  const cases=[
    {conversationHistory:history.slice(1)},
    {metaAdContext:null},
    {metaAdContext:{...ad(),attributedAt:new Date(Date.now()-8*86400000).toISOString()}},
    {conversationHistory:[...history.slice(0,-1),{role:"user",content:"所有疗程和服务的价钱都想了解"}],
     customerText:"所有疗程和服务的价钱都想了解"},
    {conversationHistory:[...history.slice(0,-1),{role:"user",content:"我现在想知道3D的价格"}],
     customerText:"我现在想知道3D的价格"},
    {conversationHistory:[history[0],{role:"user",content:"改聊9D小颜术"},
      ...history.slice(-3)]},
    {conversationHistory:[history[0],{role:"assistant",content:"[Verified STAFF message] 骨盆相关内容"},
      ...history.slice(-3)]},
    {conversationHistory:[history[0],{role:"assistant",
      content:[{type:"text",text:"[Verified STAFF message] 我们先确认"}]} , ...history.slice(-3)]},
    {conversationHistory:[history[0],...history.slice(1,-2),
      {role:"assistant",content:"你几时方便过来？"},{role:"user",content:current}]},
    {conversationHistory:[history[0],...history.slice(1,-3),
      {role:"user",content:"不用价格"},{role:"assistant",content:clarification},
      {role:"user",content:current}]},
    {conversationHistory:history.slice(0,-1).concat({role:"user",content:"每一项都想了解，我怀孕了"}),customerText:"每一项都想了解，我怀孕了"},
    {promotions:promotions.filter(x=>x.linkedService!=="骨盆调理")},
    {promotions:promotions.map(p=>p.linkedService==="骨盆调理"
      ? {...p,packages:p.packages.map(x=>x.name==="Package A"?{...x,
          caption:"优惠后仅需 RM399",
          followUpTranslations:{zh:"本月限时优惠，优惠后仅需 RM388"}}:x)}
      :p)},
  ];
  for(const override of cases) {
    assert.equal(decision(override),null,JSON.stringify(override).slice(0,220));
  }
});
test("standalone price enquiry, clinical question and future offer permission never qualify as this narrow continuation",()=>{
  for(const phrase of ["骨盆多少錢","现在我要知道每一项的价格","每一个疗程我都想了解","两次有优惠吗？","以后有优惠可以通知我","How much time does it take?"]){
    assert.equal(decision({customerText:phrase,
      conversationHistory:[...history.slice(0,-1),{role:"user",content:phrase}]}),null,phrase);
  }
});
