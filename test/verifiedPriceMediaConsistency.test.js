"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { ensureVerifiedPriceReply, verifiedPricesForService, requestedPricePackages } =
  require("../src/utils/verifiedPriceReply");

const services = [
  { name:"骨盆调理", priceRange:"" },
  { name:"9D 逆龄抗衰", priceRange:"" },
];
const serviceAliases = [{ alias:"骨盆", officialService:"骨盆调理" }];
const promotions = [
  {
    name:"骨盆调理套餐",linkedService:"骨盆调理",sendOnPriceQuery:true,
    packages:[
      {name:"Package A",aliases:["A配套"],title:"2小时30分钟",
        imageUrl:"https://example.test/pelvic-a.jpg",
        caption:"本月限时优惠\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
        mediaTranslations:{en:{caption:"Promo price RM488\nAfter voucher, only RM388"}}},
      {name:"Package B",aliases:["B配套"],title:"1小时30分钟",
        imageUrl:"https://example.test/pelvic-b.jpg",
        caption:"本月限时优惠 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣",
        mediaTranslations:{ms:{caption:"Harga asal RM388\nSekarang hanya RM288"}}},
    ],
  },
  {
    name:"9D First Trial",linkedService:"9D 逆龄抗衰",sendOnPriceQuery:true,
    imageUrl:"https://example.test/9d.jpg",
    caption:"先了解9D护理",
    followUpMessage:"🎊 限时优惠🥳\n💎只需要 RM 4️⃣8️⃣8️⃣\n(原价 RM888)",
  },
];

async function withAssessmentFirst(callback) {
  const old = config.automatedFollowUp;
  config.automatedFollowUp = {...old,assessmentFirstPricingEnabled:true};
  try { return await callback(); }
  finally { config.automatedFollowUp = old; }
}

function priceText(overrides={}) {
  return ensureVerifiedPriceReply({
    customerText:"骨盆调理多少钱？",
    reply:"骨盆调理会先了解你的体态。Package A RM999",
    treatment:"骨盆调理",
    services,serviceAliases,promotions,resultMedia:[],
    language:"zh",conversationHistory:[],
    ...overrides,
  });
}

async function priceImages(overrides={}) {
  return resolvePricePromotionForReply({
    priceQuery:true,packageQuery:false,
    treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
    customerText:"骨盆调理多少钱？",
    textSendSucceeded:true,contactId:301,promotions,services,serviceAliases,
    resultMedia:[],conversationHistory:[],
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
    ...overrides,
  });
}

test("named A and B prices yield A and B text and images, not staff-only confirmation",async()=>{
  await withAssessmentFirst(async()=>{
    const customerText="我想了解骨盆 Package A 和 Package B 的价钱";
    const quoted=priceText({customerText});
    assert.equal(quoted.restored,true);
    assert.match(quoted.reply,/Package A.*RM388/su);
    assert.match(quoted.reply,/Package B.*RM288/su);
    assert.doesNotMatch(quoted.reply,/门店帮你确认最新价格/u);
    assert.deepEqual((await priceImages({customerText}))?.packages.map(p=>p.name),
      ["Package A","Package B"]);
    assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,customerText)
      ?.map(p=>p.name),["Package A","Package B"]);
    assert.deepEqual(requestedPricePackages(promotions[0].packages,customerText)
      .map(p=>p.name),["Package A","Package B"]);
  });
});

test("one last-mentioned B selection is identical in quote and optional images",async()=>{
  await withAssessmentFirst(async()=>{
    const customerText="多少钱？";
    const conversationHistory=[
      {role:"user",content:"我想了解骨盆调理 B配套"},
      {role:"assistant",content:"好呀，你想了解什么？"},
      {role:"user",content:customerText},
    ];
    const quoted=priceText({customerText,conversationHistory});
    assert.match(quoted.reply,/Package B.*RM288/su);
    assert.doesNotMatch(quoted.reply,/Package A|RM388/u);
    assert.deepEqual((await priceImages({customerText,conversationHistory}))
      ?.packages.map(p=>p.name),["Package B"]);
    // Explicitly asking a NEW general service price does not inherit B.
    const general="骨盆调理多少钱？";
    assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,general,conversationHistory)
      ?.map(p=>p.name),["Package A","Package B"]);
  });
});

test("intervening photo and unrelated customer turn cannot carry stale B choice",async()=>{
  await withAssessmentFirst(async()=>{
    const history=[
      {role:"user",content:"骨盆调理 B配套"},
      {role:"assistant",content:"好的"},
      {role:"user",content:[{type:"image",mimeType:"image/jpeg",data:"Zg=="}]},
      {role:"assistant",content:"收到照片"},
      {role:"user",content:"多少钱？"},
    ];
    assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,"多少钱？",history)
      ?.map(p=>p.name),["Package A","Package B"]);
    assert.deepEqual((await priceImages({customerText:"多少钱？",conversationHistory:history}))
      ?.packages.map(p=>p.name),["Package A","Package B"]);
  });
});

test("conflicting, missing, and mistranslated prices all suppress optional graphics",async()=>{
  await withAssessmentFirst(async()=>{
    for (const mutation of [
      p=>{p[0].packages[0].mediaTranslations.en.caption="Now only RM999";},
      p=>{p[0].packages[0].caption="优惠后 RM388 / RM288";},
      p=>{p[0].packages[0].caption="No verified sale price";
        p[0].packages[0].mediaTranslations.en.caption="No price configured";},
    ]) {
      const bad=JSON.parse(JSON.stringify(promotions));
      mutation(bad);
      const quoted=priceText({promotions:bad});
      assert.equal(quoted.restored,true);
      assert.match(quoted.reply,/门店/u);
      assert.doesNotMatch(quoted.reply,/RM999|RM388|RM288/u);
      assert.equal(await priceImages({promotions:bad}),null);
    }
    // A verified B-only request is still allowed if unrelated A is invalid.
    const bad=JSON.parse(JSON.stringify(promotions));
    bad[0].packages[0].caption="No verified sale price";
    bad[0].packages[0].mediaTranslations.en.caption="No price configured";
    const customerText="骨盆调理 B配套多少钱？";
    assert.match(priceText({promotions:bad,customerText}).reply,/RM288/u);
    assert.deepEqual((await priceImages({promotions:bad,customerText}))
      ?.packages.map(p=>p.name),["Package B"]);
  });
});

test("mixed clinical and pricing questions verify text but never permit sales media",async()=>{
  await withAssessmentFirst(async()=>{
    const customerText="9D多少钱？做的时候会不会很痛？";
    const opts={
      customerText,treatment:"9D 逆龄抗衰",
      reply:"9D套餐 RM999，绝对不会痛。",
    };
    const text=priceText(opts);
    assert.equal(text.restored,true);
    assert.match(text.reply,/RM488/u);
    assert.doesNotMatch(text.reply,/RM999|绝对不会痛/u);
    assert.equal(await priceImages({
      ...opts,verifiedServiceFromText:"9D 逆龄抗衰",
    }),null);
  });
});
