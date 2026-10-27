"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveShadowPriceException, recentVerifiedPricingSession } =
  require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolveRecentPriceSelection, resolveTwoTreatmentPriceReply, canRecoverTwoPriceInformationReview } = require("../src/utils/priceConversationRecovery");

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
  {alias:"3D",officialService:"3D 小颜术"},
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


test("numbers describing sessions, durations or price amounts are never two treatments", () => {
  const first = [
    turn("user","想了解 3D 小颜术",210),
    turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰 两款护理",200),
  ];
  for (const current of [
    "做2小时多少钱？", "两次疗程多少钱？",
    "2小时第一次护理多少钱", "两周做一次多少钱",
    "2次是RM488吗？", "2小时的话有什么价格",
    "两个小时是多少钱", "2个人的护理多少钱", "两个星期要多少钱",
  ]) {
    assert.equal(dual([...first,turn("user",current,100)],current),null,current);
  }
});

test("an intervening pelvic selection supersedes a previously shown facial two-service menu", () => {
  const history = [
    turn("user","我想了解 3D",220),
    turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰",215),
    turn("user","我想了解骨盆调理",200),
    turn("assistant","骨盆调理主要针对体态",195),
    turn("user","这两个价钱多少",190),
  ];
  assert.equal(dual(history,"这两个价钱多少"),null);
  // Even if the later bot only said "好的", the customer's own switch
  // must invalidate the old pair.
  assert.equal(dual([
    history[0],history[1],history[2],
    turn("assistant","好的～",195), history[4],
  ],"这两个价钱多少"),null);
});

test("an assistant offering individual 3D/9D and an optional combo still supports separate prices", () => {
  for (const menu of [
    "单做 3D 小颜术、9D 逆龄抗衰，也有 3D+9D组合。",
    "可以选择 3D 小颜术，或者 9D 逆龄抗衰，另外也有组合配套",
    "3D 小颜术、9D 逆龄抗衰都是独立护理；也有3D+9D组合",
  ]) {
    const history = [
      turn("user","哪两项的价钱？",240),
      turn("assistant",menu,230),
      turn("user","这两个价钱多少",220),
    ];
    const quote = dual(history,"这两个价钱多少");
    assert.deepEqual(quote?.prices.map(x => x.treatment),
      ["3D 小颜术","9D 逆龄抗衰"],menu);
    assert.ok(quote?.prices.every(x => x.label === "first_trial"),menu);
    assert.match(quote.reply,/3D 小颜术（First Trial 体验价）：RM488/u);
    assert.match(quote.reply,/9D 逆龄抗衰（First Trial 体验价）：RM488/u);
    assert.match(quote.reply,/不是组合配套/u);
  }
});

test("a combo-only pitch is not evidence of two separately quoted services", () => {
  const base = [
    turn("user","我想了解价钱",210),
    turn("assistant","现在有 3D+9D组合限时优惠",200),
    turn("user","这两个价钱多少",190),
  ];
  assert.equal(dual(base,"这两个价钱多少"),null);
  assert.equal(dual([
    base[0],turn("assistant","有 3D 小颜术、9D 逆龄抗衰、骨盆调理",200),base[2],
  ],"这两个价钱多少"),null,"more than two presented treatments is ambiguous");
});

test("two individually named treatments can be quoted without borrowing an assistant menu", () => {
  const history = [
    turn("user","你好",220),
    turn("assistant","你好，请问想了解什么？",215),
    turn("user","3D和9D多少钱？",200),
  ];
  const result=dual(history,"3D和9D多少钱？");
  assert.equal(result?.prices.length,2);
  assert.deepEqual(result?.prices.map(x=>x.label),["first_trial","first_trial"]);
});

test("unknown labels remain current offers, never an invented First Trial", () => {
  const history=[
    turn("user","你们有哪些价钱？",220),
    turn("assistant","我们有 3D 小颜术、9D 逆龄抗衰",215),
    turn("user","这两个价钱多少",200),
  ];
  const generic = promotions.map(p => p.linkedService !== "9D 逆龄抗衰" ? p : ({
    ...p,name:"9D 优惠",caption:"优惠价 RM488",
  }));
  const answer=resolveTwoTreatmentPriceReply({
    customerText:"这两个价钱多少",
    session:recentVerifiedPricingSession(history,"这两个价钱多少",now),
    services,serviceAliases,promotions:generic,language:"zh",now,
  });
  assert.equal(answer?.prices[1].label,"current_offer");
  assert.match(answer.reply,/9D 逆龄抗衰（当前优惠价）：RM488/u);
  assert.doesNotMatch(answer.reply,/9D 逆龄抗衰（First Trial/u);
});

test("two-treatment decisions are audited as approved text-only and never select images", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(source,/approved: Boolean\(approvedPricingDecision \|\| twoTreatmentQuote\)/u);
  assert.match(source,/approvalReason: twoTreatmentQuote \? "two_treatments_verified_text_only"/u);
  assert.match(source,/decisionSource: twoTreatmentQuote\?\.source/u);
  assert.match(source,/const promoBundle = twoTreatmentQuote \? null : await resolvePricePromotionForReply/u);
  assert.match(source,/replyStatus: !sendOutcome\.sendResult\.success \? "text_not_accepted"/u);
});


test("20-message truncated history beginning with an assistant preserves a fresh customer-confirmed price", () => {
  const tail = [
    turn("user","想了解 3D 小颜术",200),
    turn("assistant","我们的 3D 小颜术是徒手面部护理",190),
    turn("user","请问一次多少钱",180),
  ];
  const orphan = Array.from({length:17},(_,i)=>
    turn("assistant","[Automated explanation] 好的",2400-(i*100))
  );
  const history=[...orphan,...tail]; // same 20-message limit as the Inbox AI snapshot
  assert.equal(history.length,20);
  const session=recentVerifiedPricingSession(history,"请问一次多少钱",now);
  assert.equal(session?.[0]?.content,"想了解 3D 小颜术");
  assert.equal(shadow(history,"请问一次多少钱")?.treatment,"3D 小颜术");
  const unsafe=[...orphan];
  unsafe[3]=turn("assistant","[Verified STAFF message] 请稍等",2100,true);
  assert.equal(recentVerifiedPricingSession([...unsafe,...tail],"请问一次多少钱",now),null);
  const untrusted=history.map(x=>({...x}));
  delete untrusted[0].pricingCreatedAtMs;
  assert.equal(recentVerifiedPricingSession(untrusted,"请问一次多少钱",now)?.[0].role,"user",
    "a missing boundary timestamp must not authorize old orphan assistant content");
  delete untrusted[18].pricingCreatedAtMs;
  assert.equal(shadow(untrusted,"请问一次多少钱"),null,
    "missing timestamps inside the customer-led exchange never recover its earlier treatment");
});

test("three-turn fee clarification accepts a bot-grounded facial concern, not a generic alias guess", () => {
  const question=turn("user","请问价格是多少",130);
  const mapped=turn("assistant",
    "你想了解哪项护理的价格？3D 小颜术可以改善大小脸，9D 逆龄抗衰主要是紧致。",120);
  const selected=turn("user","调整大小脸",110);
  const history=[question,mapped,selected];
  assert.equal(shadow(history,"调整大小脸")?.treatment,"3D 小颜术");
  assert.equal(shadow(history,"调整大小脸")?.source,"customer_price_selection");
  assert.equal(shadow([
    question,turn("assistant","我们有 3D 小颜术 和 9D 逆龄抗衰，哪项价钱？",120),selected,
  ],"调整大小脸"),null,
  "the bot must actually associate the concern with one specific treatment");
  assert.equal(shadow([
    question,turn("assistant","9D 逆龄抗衰可以改善大小脸，3D 小颜术也有",120),selected,
  ],"调整大小脸"),null,"no contradictory or model-inferred concern mapping");
  const named=shadow([
    question,turn("assistant","请问你想了解哪一项疗程的价格呢？",120),
    turn("user","3D",110),
  ],"3D");
  assert.equal(named?.treatment,"3D 小颜术","live Neutro has exact 3D alias");
});

test("two-item answer directly resolves an immediate priced two-treatment menu", () => {
  for (const content of ["两个","两项","both","两个都想了解"]) {
    const history=[
      turn("user","想了解护理",160),
      turn("assistant","你想了解 3D 小颜术 还是 9D 逆龄抗衰的价钱？",150),
      turn("user",content,140),
    ];
    const result=dual(history,content);
    assert.deepEqual(result?.prices.map(x=>x.treatment),
      ["3D 小颜术","9D 逆龄抗衰"],content);
    assert.deepEqual(result?.prices.map(x=>x.amount),["RM488","RM488"]);
  }
});

test("two-item answer does not turn two packages, concerns or sessions into two treatment prices", () => {
  const prefixes=[
    "3D 小颜术 Package A 和 Package B，你想了解哪个配套的价钱？",
    "3D 小颜术与 9D 逆龄抗衰有两种问题，你更在意哪种呢？",
    "我们的 3D 小颜术 和 9D 逆龄抗衰每个项目各有两个配套，请问想了解哪个配套价钱？",
    "3D 小颜术每次40分钟，可以做两次，请问想做几次？",
  ];
  for(const content of prefixes){
    const history=[turn("user","想了解",220),turn("assistant",content,210),
      turn("user","两个",200)];
    assert.equal(dual(history,"两个"),null,content);
  }
});

test("explicit separate prices with a negated combo are independently verified", () => {
  const msgs=[
    "3D 和 9D 分开多少钱？不要组合",
    "3D 和 9D 各自价钱多少？不是组合配套",
    "3D 和 9D 分别多少钱？不需要组合",
  ];
  for(const current of msgs){
    const history=[turn("user","你好",180),
      turn("assistant","你好，想了解什么护理呢？",170),
      turn("user",current,160)];
    const result=dual(history,current);
    assert.deepEqual(result?.prices.map(x=>x.treatment),
      ["3D 小颜术","9D 逆龄抗衰"],current);
    assert.match(result?.reply||"",/不是组合配套/u);
  }
  for(const current of ["3D+9D组合多少钱","不要3D，9D多少钱",
    "我不要3D也不要9D，多少钱","3D和9D的组合多少钱"]){
    const history=[turn("user","你好",180),
      turn("assistant","我们有 3D 小颜术和 9D 逆龄抗衰",170),
      turn("user",current,160)];
    assert.equal(dual(history,current),null,current);
  }
});

test("information-review recovery requires a verified dual quote and fresh no-clinical-review evidence", () => {
  const history=[
    turn("user","想了解",200),
    turn("assistant","你想了解 3D 小颜术 还是 9D 逆龄抗衰的价钱？",195),
    turn("user","两个",190),
  ];
  const quote=dual(history,"两个");
  assert.ok(quote?.prices?.length===2);
  const base={quote,flagged:true,reviewRequired:true,reviewType:"information"};
  assert.equal(canRecoverTwoPriceInformationReview({...base,pendingClinicalReview:false}),true);
  assert.equal(canRecoverTwoPriceInformationReview({...base,pendingClinicalReview:null}),false);
  assert.equal(canRecoverTwoPriceInformationReview({...base,pendingClinicalReview:true}),false);
  assert.equal(canRecoverTwoPriceInformationReview({...base,reviewType:"clinical",pendingClinicalReview:false}),false);
  assert.equal(canRecoverTwoPriceInformationReview({...base,reviewRequired:false,pendingClinicalReview:false}),false);
  assert.equal(canRecoverTwoPriceInformationReview({...base,flagged:false,pendingClinicalReview:false}),false);
  assert.equal(canRecoverTwoPriceInformationReview({...base,quote:null,pendingClinicalReview:false}),false);
});

test("outbound two-treatment quote is guarded before the model information handoff and stays text-only", () => {
  const fs=require("node:fs"),path=require("node:path");
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const quotePosition=source.indexOf("let twoTreatmentQuote = aiPricingMode");
  const approvalPosition=source.indexOf("const pricingApproval = resolveApprovedPricingAssessment");
  const recoverPosition=source.indexOf("canRecoverTwoPriceInformationReview({");
  const sendPosition=source.indexOf("const sendOutcome = await sendTrackedText(");
  assert.ok(quotePosition>0 && quotePosition<approvalPosition);
  assert.ok(recoverPosition>quotePosition && recoverPosition<approvalPosition);
  assert.ok(sendPosition>approvalPosition);
  assert.match(source,/getTcmReviewEvidence\(\s*contact\.id, savedInbound\.id\s*\)/u);
  assert.match(source,/if \(twoTreatmentQuote\) \{\s*\/\/ A verified multi-treatment request/u);
  assert.match(source,/const promoBundle = twoTreatmentQuote \? null : await resolvePricePromotionForReply/u);
  assert.match(source,/mediaReason: promoBundle \? null : pricingMediaSkipReason/u);
});


test("a first inbound message that names two treatments and asks separate prices needs no prior menu", () => {
  for(const current of [
    "3D 和 9D 分开多少钱？不要组合",
    "3D and 9D separately, not the combo, how much?",
    "3D dan 9D berapa harga? bukan pakej",
  ]){
    const history=[turn("user",current,50)];
    const result=dual(history,current);
    assert.deepEqual(result?.prices.map(x=>x.treatment),
      ["3D 小颜术","9D 逆龄抗衰"],current);
    assert.deepEqual(result?.prices.map(x=>x.amount),["RM488","RM488"]);
  }
  for(const current of ["这两个多少钱","两个","3D+9D组合多少钱","做两次多少钱"]){
    const history=[turn("user",current,50)];
    assert.equal(dual(history,current),null,current);
  }
});

test("no-combo negation cannot hide safety or treatment rejection", () => {
  const candidates=[
    "3D 和 9D 我都不要，别发价钱",
    "3D 和 9D 都不要组合，也不用发我优惠",
    "3D+9D组合就是我要的，多少钱？",
    "我要combo 3D 和 9D，多少钱",
  ];
  for(const current of candidates){
    assert.equal(dual([turn("user",current,60)],current),null,current);
  }
});
