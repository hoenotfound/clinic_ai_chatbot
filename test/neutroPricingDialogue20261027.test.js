"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveShadowPriceException, recentVerifiedPricingSession } =
  require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolveTwoTreatmentPriceReply } = require("../src/utils/priceConversationRecovery");

const now = Date.now();
const turn = (role, content, secondsBefore = 0, staff = false) => ({
  role, content, pricingCreatedAtMs:now - secondsBefore * 1000,
  pricingStaffAuthored:staff,
});
const services = [
  {name:"骨盆调理"}, {name:"3D 小颜术"}, {name:"9D 逆龄抗衰"},
  {name:"3D + 9D 组合"}, {name:"1对1体态评估"},
];
const serviceAliases = [
  {alias:"骨盆",officialService:"骨盆调理"},
  {alias:"盆骨调整",officialService:"骨盆调理"},
  {alias:"3D小颜术",officialService:"3D 小颜术"},
  {alias:"9D",officialService:"9D 逆龄抗衰"},
];
const promotions = [
  {name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    imageUrl:"https://example.test/3d.jpg",
    pricing:{currency:"MYR",offer:488,normal:888},
    caption:"3D 小颜术 First Trial，原价 RM888，优惠 RM488"},
  {name:"9D 逆龄抗衰 First Trial",linkedService:"9D 逆龄抗衰",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    imageUrl:"https://example.test/9d.jpg",
    pricing:{currency:"MYR",offer:488,normal:1288},
    caption:"9D 逆龄抗衰 First Trial，原价 RM1288，优惠 RM488"},
  {name:"骨盆调理套餐",linkedService:"骨盆调理",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    packages:[
      {name:"Package A",title:"尊享护理配套",imageUrl:"https://example.test/pelvic-a.jpg",
        caption:"原价 RM488，优惠后仅需 RM388"},
      {name:"Package B",title:"女性护理配套",imageUrl:"https://example.test/pelvic-b.jpg",
        caption:"原价 RM388，现在只需 RM288"},
    ]},
  {name:"9D + 3D 组合限时优惠",linkedService:"3D + 9D 组合",
    sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
    imageUrl:"https://example.test/combo.jpg",caption:"组合配套可到店了解"},
];

const shadow = (history, text) => resolveShadowPriceException({
  customerText:text,conversationHistory:history,services,serviceAliases,
  promotions,now,complimentaryAssessmentExperienceEnabled:true,
});
const dual = (history,text) => resolveTwoTreatmentPriceReply({
  customerText:text,
  session:recentVerifiedPricingSession(history,text,now),
  services,serviceAliases,promotions,language:"zh",now,
});

test("contact 811: a customer selecting 3D after 'what options?' keeps the earlier fee request", () => {
  const history = [
    turn("user","Hi～想了解 Neutro Sense TCM 3D 小颜术，可以跟进我",400),
    turn("assistant","你对 3D 小颜术有兴趣对吗？",390),
    turn("user","请问收费如何呢？",250),
    turn("assistant","请问你想了解哪一项疗程的价格呢？",245),
    turn("user","有什么选项呢？",200),
    turn("assistant","单做 3D 小颜术，或者搭配 9D 逆龄抗衰组合。你想了解哪一个？",190),
    turn("user","3D",180),
  ];
  const result=shadow(history,"3D");
  assert.equal(result?.treatment,"3D 小颜术");
  assert.equal(result?.source,"customer_price_selection");
  assert.deepEqual(result?.prices.map(p=>p.price),["RM488"]);
  const approval=resolveApprovedPricingAssessment({
    mode:"shadow",shadowException:result,customerText:"3D",
    conversationHistory:history,services,serviceAliases,
    flagged:false,bookingReady:false,now,
  });
  assert.equal(approval.reason,"approved");
  const quoted=ensureVerifiedPriceReply({
    customerText:"3D",reply:"我们可以先评估哦",
    treatment:result.treatment,clarifiedPriceService:result.treatment,
    verifiedShadowPriceService:result.treatment,pricingDecision:result,
    priceOnlyResponse:true,conversationHistory:history,
    services,serviceAliases,promotions,language:"zh",
  });
  assert.match(quoted.reply,/RM488/u);
});

test("contact 686: '调整大小脸' after treatment-fee clarification is 3D, not a model guess", () => {
  const history = [
    turn("user","Hi～想了解 3D 小颜术",1200),
    turn("assistant","我们的 3D 小颜术会改善脸型轮廓视觉",1190),
    turn("user","大小脸视觉",300),
    turn("assistant","3D 小颜术主要是徒手放松面部肌肉",295),
    turn("user","想询问价格 谢谢",240),
    turn("assistant","请问你想了解哪一项疗程的价格呢？",230),
    turn("user","调整大小脸",200),
  ];
  const decision=shadow(history,"调整大小脸");
  assert.equal(decision?.treatment,"3D 小颜术");
  assert.equal(decision?.source,"customer_price_selection");
  assert.deepEqual(decision?.prices.map(p=>p.price),["RM488"]);
});

test("contacts 686, 811, 815: a short price follow-up keeps a recent customer-established service", () => {
  const examples = [
    [
      turn("user","大小脸视觉",340),
      turn("assistant","我们的 3D 小颜术是徒手护理",330),
      turn("user","感觉这一年吧",220),
      turn("assistant","可以先看看脸部状态",210),
      turn("user","有first trial 的价钱吗？",200),
    ],
    [
      turn("user","想了解 3D 小颜术",540),
      turn("assistant","3D 小颜术主要是脸部轮廓",535),
      turn("user","Weekend",420),
      turn("assistant","这个周末可以咨询中医师",410),
      turn("user","一次疗程多少钱",400),
    ],
    [
      turn("user","3D 小颜术",300),
      turn("assistant","我们有 3D 小颜术的护理",290),
      turn("user","第一评估是免费？",100),
      turn("assistant","体态评估免费，3D 小颜术 First Trial 单独收费",90),
      turn("user","多少钱",70),
    ],
  ];
  for (const history of examples) {
    const text=history.at(-1).content;
    const result=shadow(history,text);
    assert.equal(result?.treatment,"3D 小颜术",text);
    assert.deepEqual(result?.prices.map(x=>x.price),["RM488"]);
  }
});

test("contact 788: explicit pelvic fee enquiry still selects pelvic packages", () => {
  const history = [
    turn("user","我对骨盆调理有兴趣",220),
    turn("assistant","骨盆调理是一种体态护理",215),
    turn("assistant","骨盆 Before & After",210),
    turn("user","想知道价格",200),
  ];
  const selected=shadow(history,"想知道价格");
  assert.equal(selected?.treatment,"骨盆调理");
  assert.deepEqual(selected?.prices.map(x=>x.price),["RM388","RM288"]);
});

test("contact 774: '这两个价钱多少' means separate 3D and 9D offers, not their combo", () => {
  const history=[
    turn("user","想了解 3D 小颜术",420),
    turn("assistant","3D 小颜术",410),
    turn("user","价钱有分别？",300),
    turn("assistant","请问你想了解哪一项疗程的价格呢？",290),
    turn("user","不知道",260),
    turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰 两款护理",250),
    turn("user","这两个价钱多少",200),
  ];
  const answer=dual(history,"这两个价钱多少");
  assert.deepEqual(answer?.prices.map(x=>x.treatment),
    ["3D 小颜术","9D 逆龄抗衰"]);
  assert.deepEqual(answer?.prices.map(x=>x.amount),["RM488","RM488"]);
  assert.match(answer.reply,/不是组合配套/u);
  const next=[
    ...history,turn("assistant","请问你想了解哪一项疗程的价格呢？",190),
    turn("user","两个",180),
  ];
  assert.deepEqual(dual(next,"两个")?.prices.map(x=>x.treatment),
    ["3D 小颜术","9D 逆龄抗衰"]);
});

test("contact 841: bot named both services then customer requests both prices", () => {
  const history=[
    turn("user","多少钱？",240),
    turn("assistant","你想了解 3D 小颜术 还是 9D 逆龄抗衰的价钱？",230),
    turn("user","两頁价錢都给呗",180),
  ];
  const quote=dual(history,"两頁价錢都给呗");
  assert.equal(quote?.prices.length,2);
  assert.match(quote?.reply || "",/3D 小颜术.*RM488/su);
  assert.match(quote?.reply || "",/9D 逆龄抗衰.*RM488/su);
});

test("two-price recovery rejects marketing consent, staff, stale sessions, free fees and combo pricing", () => {
  const base=[
    turn("user","想了解 3D 小颜术",400),
    turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰 两款护理",390),
    turn("user","这两个价钱多少",380),
  ];
  assert.equal(dual(base.slice(0,2).concat(turn("user","可以跟进我有优惠就发",380)),
    "可以跟进我有优惠就发"),null);
  assert.equal(dual(base.slice(0,2).concat(turn("user","3D+9D组合多少钱",380)),
    "3D+9D组合多少钱"),null);
  assert.equal(dual(base.slice(0,2).concat(turn("user","全部疗程价目表",380)),
    "全部疗程价目表"),null);
  assert.equal(dual(base.slice(0,2).concat(turn("user","评估这两个多少钱",380)),
    "评估这两个多少钱"),null);
  assert.equal(dual([base[0], turn("assistant","3D 和 9D 两项",390,true),base[2]],
    "这两个价钱多少"),null);
  assert.equal(dual([
    turn("user","想了解 3D 小颜术",15000),
    turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰",14990),
    turn("user","这两个价钱多少",380),
  ],"这两个价钱多少"),null);
  assert.equal(dual(base.slice(0,2).concat(turn("user","我有糖尿病，这两个多少钱",380)),
    "我有糖尿病，这两个多少钱"),null);
  assert.equal(resolveTwoTreatmentPriceReply({
    customerText:"这两个价钱多少",
    session:recentVerifiedPricingSession(base,"这两个价钱多少",now),
    services,serviceAliases,promotions:promotions.filter(p=>p.linkedService!=="9D 逆龄抗衰"),
    now,
  }),null);
});

test("pricing dialogue is never carried past verified human staff intervention", () => {
  const history=[
    turn("user","想了解 3D 小颜术",500),
    turn("assistant","可以介绍 3D 小颜术",490),
    turn("assistant","[Verified STAFF message] 我们帮你报价",400,true),
    turn("user","多少钱",200),
  ];
  assert.equal(shadow(history,"多少钱"),null);
});
