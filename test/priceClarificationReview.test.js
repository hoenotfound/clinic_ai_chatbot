"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { configuredOfferPrice, verifiedPricesForService, ensureVerifiedPriceReply } =
  require("../src/utils/verifiedPriceReply");
const { resolveClarifiedPriceService } = require("../src/utils/priceClarificationContext");

const promotions = [
  { name:"Pelvic packages",linkedService:"骨盆调理",sendOnPriceQuery:true,packages:[
    { name:"Package A",aliases:["A配套"],caption:"本月限时优惠 🔥\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
      mediaTranslations:{en:{caption:"Promo price RM488\nAfter voucher, only RM3️⃣8️⃣8️⃣"},ms:{caption:"Harga promosi RM488\nSelepas baucar, hanya RM388"}},
      imageUrl:"https://example.test/a" },
    { name:"Package B",aliases:["B配套"],caption:"本月限时优惠 🔥 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣",
      mediaTranslations:{en:{caption:"Original price RM388\nNow only RM288"}},
      imageUrl:"https://example.test/b" },
  ]},
  { name:"3D First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
    caption:"Treatment explanation",followUpMessage:"💎只需 RM 4️⃣8️⃣8️⃣ (原价 RM1288)",
    followUpTranslations:{en:"🎊 Limited-time offer\n💎 RM 4️⃣8️⃣8️⃣\n(Original price RM1,288)",ms:"🎊 Promosi masa terhad\n💎 RM488\n(Harga asal RM1,288)"},imageUrl:"https://example.test/3d" },
  { name:"9D First Trial",linkedService:"9D 逆龄抗衰",sendOnPriceQuery:true,
    caption:"Treatment explanation",followUpMessage:"💎只需要 RM 4️⃣8️⃣8️⃣ (原价 RM888)",imageUrl:"https://example.test/9d" },
  { name:"Combination",linkedService:"3D + 9D 组合",sendOnPriceQuery:true,
    caption:"✨ 9D + 3D 组合限时优惠: RM688",followUpMessage:"组合体验价只需 RM688",
    mediaTranslations:{en:{caption:"✨ 9D + 3D Limited-Time Combo Offer: RM688"},ms:{caption:"✨ Promosi Kombo 9D + 3D Masa Terhad: RM688"}},imageUrl:"https://example.test/combo" },
];
const services = [ { name:"骨盆调理" },{ name:"3D 小颜术" } ];
const aliases = [{ alias:"骨盆",officialService:"骨盆调理" },{ alias:"骨盆调整",officialService:"骨盆调理" }];
const konny = [
  {role:"user",content:"想大概了解价钱"},
  {role:"assistant",content:"请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊"},
  {role:"user",content:"调整骨盆"},
];
const base = {
  customerText:"调整骨盆",reply:"骨盆调理会先了解体态情况。\nPackage A RM999。",
  treatment:"骨盆调理",clarifiedPriceService:"骨盆调理",
  services,serviceAliases:aliases,promotions,conversationHistory:konny,language:"zh",
};

test("anchored price parser separates vouchers, originals and contradictory amounts", () => {
  assert.equal(configuredOfferPrice("优惠后 RM388，另送 RM100 voucher"),"RM388");
  assert.equal(configuredOfferPrice("Promo price RM488\nAfter voucher, only RM388"),"RM388");
  assert.equal(configuredOfferPrice("💎只需 RM 4️⃣8️⃣8️⃣ (原价 RM1288)"),"RM488");
  assert.equal(configuredOfferPrice("✨ 9D + 3D 组合限时优惠: RM688"),"RM688");
  assert.equal(configuredOfferPrice("RM100 voucher"),null);
  assert.equal(configuredOfferPrice("原价 RM488"),null);
  assert.equal(configuredOfferPrice("优惠后 RM388 / RM288"),null);
  assert.equal(configuredOfferPrice("优惠后 RM388，优惠后 RM288"),null);
  assert.equal(configuredOfferPrice("优惠后 RM388，另送 RM200"),null);
});

test("active configured offers produce the expected four treatment prices", () => {
  const expected={"骨盆调理":["RM388","RM288"],"3D 小颜术":["RM488"],
    "9D 逆龄抗衰":["RM488"],"3D + 9D 组合":["RM688"]};
  for(const [treatment,amounts] of Object.entries(expected)) {
    assert.deepEqual(verifiedPricesForService(treatment,promotions)?.map(p=>p.price),amounts,treatment);
  }
});

test("explicit package selection returns only that package",()=>{
  assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,"我想知道 B配套 多少钱")?.map(p=>p.name),["Package B"]);
  assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,"Package A price?")?.map(p=>p.name),["Package A"]);
  assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,"调整骨盆")?.map(p=>p.name),["Package A","Package B"]);
  assert.deepEqual(verifiedPricesForService("骨盆调理",promotions,"Package A and Package B prices")?.map(p=>p.name),["Package A","Package B"]);
  assert.match(ensureVerifiedPriceReply({...base,customerText:"骨盆调理 B配套多少钱?"}).reply,/RM288/u);
  assert.doesNotMatch(ensureVerifiedPriceReply({...base,customerText:"骨盆调理 B配套多少钱?"}).reply,/RM388/u);
});

test("all AI price drafts are checked against active offers",()=>{
  for(const reply of ["Package A RM388","Package A RM388 / Package B RM288",
    "Package A RM999","骨盆调理主要会先了解体态情况。\nA配套 RM999。"]) {
    const result=ensureVerifiedPriceReply({...base,reply});
    assert.equal(result.restored,true,reply);
    assert.match(result.reply,/RM388/u);
    assert.match(result.reply,/RM288/u);
    assert.doesNotMatch(result.reply,/RM999/u);
  }
  const preserved=ensureVerifiedPriceReply(base);
  assert.match(preserved.reply,/会先了解体态情况/u);
});

test("conflicting clinic sources cause staff confirmation rather than a guessed price",()=>{
  const wrong=JSON.parse(JSON.stringify(promotions));
  wrong[0].packages[0].mediaTranslations.en.caption="Now only RM999";
  const result=ensureVerifiedPriceReply({...base,promotions:wrong});
  assert.equal(result.restored,true);
  assert.match(result.reply,/门店/u);
  assert.doesNotMatch(result.reply,/RM999|RM388|RM288/u);
  const translatedConflict=JSON.parse(JSON.stringify(promotions));
  translatedConflict[2].followUpTranslations={en:"🎊 Limited-time offer\\n💎 RM999\\n(Original price RM888)"};
  assert.equal(verifiedPricesForService("9D 逆龄抗衰",translatedConflict),null);
  const missing=ensureVerifiedPriceReply({...base,promotions:[]});
  assert.equal(missing.restored,true);
  assert.doesNotMatch(missing.reply,/RM999/u);
});

test("an intervening media turn must not extend a price clarification",()=>{
  const interrupted=[...konny.slice(0,2),
    {role:"user",content:[{type:"image",mimeType:"image/jpeg",data:"aGVsbG8="}]},
    konny[2]];
  assert.equal(resolveClarifiedPriceService({
    customerText:"调整骨盆",conversationHistory:interrupted,
    services,serviceAliases:aliases,
  }),null);
  assert.equal(resolveClarifiedPriceService({
    customerText:"调整骨盆",conversationHistory:konny,
    services,serviceAliases:aliases,
  }),"骨盆调理");
});
