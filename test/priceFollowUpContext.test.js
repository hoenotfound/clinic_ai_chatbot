"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { safeServiceFromCustomer, guardAssessmentFirstPricingReply } =
  require("../src/utils/initialOfferReplyGuard");
const { resolveVerifiedPriceFollowUpService, isContextualPriceReference } =
  require("../src/utils/priceFollowUpContext");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name:"骨盆调理", priceRange:"" },
  { name:"3D 小颜术", priceRange:"RM488" },
  { name:"徒手体态调理", priceRange:"" },
];
const serviceAliases = [
  { alias:"骨盆", officialService:"骨盆调理" },
  { alias:"3D", officialService:"3D 小颜术" },
  { alias:"整骨", officialService:"徒手体态调理" },
];
const promotions = [
  { name:"October pelvic", linkedService:"骨盆调理", sendOnPriceQuery:true,
    packages:[
      {name:"Package A",aliases:["A配套"],imageUrl:"https://example.test/a",
       caption:"本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM388",
       mediaTranslations:{en:{caption:"Promo price RM488\nAfter voucher, only RM388"}}},
      {name:"Package B",aliases:["B配套"],imageUrl:"https://example.test/b",
       caption:"本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM288"},
    ]},
  { name:"3D first trial", linkedService:"3D 小颜术", sendOnPriceQuery:true,
    imageUrl:"https://example.test/3d", caption:"关于3D疗程",
    followUpMessage:"🎊 限时优惠🥳\n💎只需 RM488\n(原价 RM1288)"},
];
const history = (...rows) => rows.map(([role,content])=>({role,content}));
const convoB = history(
  ["user","我想了解骨盆调理"],
  ["assistant","我们可以先了解您的需求"],
  ["user","我想知道 B配套包括什么"],
  ["assistant","B配套有骨盆和子宫护理"],
  ["user","这个多少钱？"],
);
const common = { services, serviceAliases, promotions };
function resolved(text, turns) {
  return resolveVerifiedPriceFollowUpService({
    customerText:text, conversationHistory:turns, ...common,
  })?.name || null;
}
async function withAssessmentFirst(callback) {
  const previous = config.automatedFollowUp;
  config.automatedFollowUp = {...previous, assessmentFirstPricingEnabled:true};
  try { return await callback(); }
  finally { config.automatedFollowUp = previous; }
}
function textReply(text,turns,offerName="骨盆调理") {
  const treatment=resolved(text,turns) ||
    safeServiceFromCustomer(text, services, serviceAliases)?.name || null;
  const reply=guardAssessmentFirstPricingReply({
    customerText:text,reply:"我们有 RM999 的配套",treatment,
    requireVerifiedTreatment:true,services,serviceAliases,
    conversationHistory:turns,language:"zh",resultMedia:[],
  }).reply;
  return ensureVerifiedPriceReply({
    customerText:text,reply,treatment,language:"zh",resultMedia:[],
    services,serviceAliases,promotions,conversationHistory:turns,
  });
}
async function media(text, turns, treatment) {
  return withAssessmentFirst(async()=>resolvePricePromotionForReply({
    priceQuery:false,packageQuery:false,
    treatment,verifiedServiceFromText:treatment,
    customerText:text,conversationHistory:turns,services,serviceAliases,
    promotions,resultMedia:[],contactId:100,textSendSucceeded:true,
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
  }));
}

test("customer-named pelvic service and Package B survive a deictic price question",async()=>{
  const text="这个多少钱？";
  assert.equal(isContextualPriceReference(text),true);
  assert.equal(resolved(text,convoB),"骨盆调理");
  const result=textReply(text,convoB);
  assert.equal(result.restored,true);
  assert.match(result.reply,/Package B.*RM288/su);
  assert.doesNotMatch(result.reply,/RM999|Package A|RM388/u);
  const images=await media(text,convoB,"骨盆调理");
  assert.deepEqual(images?.packages.map(x=>x.name),["Package B"]);
});

test("short 'B配套多少钱' uses recent pelvic service, never a CRM or model guess",async()=>{
  const turns=history(
    ["user","我想了解骨盆调理"],
    ["assistant","可以，帮你说明"],
    ["user","B配套多少钱？"],
  );
  assert.equal(resolved("B配套多少钱？",turns),"骨盆调理");
  assert.match(textReply("B配套多少钱？",turns).reply,/Package B.*RM288/su);
  assert.deepEqual((await media("B配套多少钱？",turns,"骨盆调理"))
    ?.packages.map(x=>x.name),["Package B"]);
  assert.equal(resolved("B配套多少钱？",history(["user","B配套多少钱？"])),null);
});

test("standalone Chinese Malay and English price questions keep a recent customer service",()=>{
  for(const text of ["多少钱？","Berapa?","price?","how much?","How much is it?","What is the price for that?"]) {
    const turns=history(["user","我想了解3D 小颜术"],["assistant","好呀"],["user",text]);
    assert.equal(resolved(text,turns),"3D 小颜术",text);
    assert.match(textReply(text,turns).reply,/RM488/u,text);
  }
});

test("ambiguous topics, marketing consent, refusals, photos and staff messages never grant pricing",async()=>{
  const scenarios=[
    history(["user","我想了解3D 和骨盆调理"],["assistant","好的"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user","换个话题聊地址"],["assistant","地址在PJ"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user","之后有优惠可以通知我"],["assistant","收到"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","好的"],["user",[{type:"image"}]],["assistant","照片收到"],["user","这个多少钱？"]),
    history(["user","骨盆调理"],["assistant","[Verified STAFF message] 好的"],["user","多少钱？"]),
    history(["user","整骨"],["assistant","好的"],["user","B配套多少钱？"]),
  ];
  for(const turns of scenarios){
    const text=turns.at(-1).content;
    assert.equal(resolved(text,turns),null,JSON.stringify(turns));
  }
  for(const text of ["How much longer?", "Berapa lama?", "我不要价钱", "全部疗程多少钱？"]){
    const turns=history(["user","骨盆调理"],["assistant","好的"],["user",text]);
    assert.equal(resolved(text,turns),null,text);
  }
});

test("latest explicit service wins, but a B package from another treatment cannot be borrowed",()=>{
  const changed=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","我想了解3D 小颜术"],["assistant","收到"],["user","B配套多少钱？"]);
  assert.equal(resolved("B配套多少钱？",changed),null);
  const price=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","我想了解3D 小颜术"],["assistant","收到"],["user","这个多少钱？"]);
  assert.equal(resolved("这个多少钱？",price),"3D 小颜术");
});

test("conditional voucher price is not promised to be unconditional or stackable",()=>{
  const turns=history(["user","我想了解骨盆调理"],["assistant","好的"],
    ["user","A配套多少钱？"]);
  const quote=textReply("A配套多少钱？",turns);
  assert.match(quote.reply,/Package A.*RM388/su);
  assert.match(quote.reply,/优惠券后的价格/u);
  assert.match(quote.reply,/须符合领取及使用条件/u);
  assert.doesNotMatch(quote.reply,/RM288|自动享有|肯定叠加/u);
  const bTurns=history(["user","骨盆调理"],["assistant","好的"],
    ["user","B配套多少钱？"]);
  assert.doesNotMatch(textReply("B配套多少钱？",bTurns).reply,/优惠券后的价格/u);
});
