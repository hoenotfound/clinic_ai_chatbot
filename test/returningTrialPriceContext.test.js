"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { resolveReturningFirstTrialPriceService } =
  require("../src/utils/returningTrialPriceContext");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const now = Date.now();
const HOUR = 60 * 60 * 1000;
const services = [
  { name: "骨盆调理" }, { name: "3D 小颜术" },
  { name: "徒手体态调理" }, { name: "1对1体态评估" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "整骨", officialService: "徒手体态调理" },
  { alias: "体态评估", officialService: "1对1体态评估" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理",
  sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
  packages: [
    {
      name: "Package A", title: "尊享护理配套", imageUrl: "https://example.test/a.jpg",
      caption: "本月限时优惠\n原价 RM488\n优惠后仅需 RM388",
      pricing: { currency: "MYR", offer: 388, normal: 488 },
    },
    {
      name: "Package B", title: "女性护理配套", imageUrl: "https://example.test/b.jpg",
      caption: "本月限时优惠\n原价 RM388\n现在只需 RM288",
      pricing: { currency: "MYR", offer: 288, normal: 388 },
    },
  ],
}];
const text = "想问下第一次体验的价格是多少呀";
const turn = (role, content, hoursAgo, staff = false) => ({
  role, content, pricingCreatedAtMs: now - hoursAgo * HOUR,
  pricingStaffAuthored: staff,
});

// The customer picked pelvic care two days earlier. All intervening messages
// are the chatbot's automatic results, media captions and scheduled follow-ups.
// A new inbound message reopens the normal WhatsApp service window.
function returningHistory() {
  return [
    turn("user",
      "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊", 48.04),
    turn("assistant", "Hi～欢迎来到 Neutro Sense 😊 想了解骨盆调理对吗～", 48.03),
    turn("assistant", "这个是我们顾客护理后的 Before & After，骨盆和体态供参考", 48.02),
    turn("assistant", "再给你看一位顾客的骨盆护理经验", 48.01),
    turn("assistant", "骨盆调理的小影片你可以先看看 😊", 46.02),
    turn("assistant", "跟你分享一位顾客的骨盆调理体验 😊", 42.02),
    turn("assistant",
      "如果你之后想先了解自己的体态或骨盆情况，可以先安排免费的1对1体态评估+体验", 28.02),
    turn("assistant", "小提醒：第一次来咨询护理，可以先了解过程和注意事项", 0.04),
    turn("user", text, 0.005),
  ];
}
const args = (overrides = {}) => ({
  customerText: text, conversationHistory: returningHistory(),
  services, serviceAliases, promotions, now,
  complimentaryAssessmentExperienceEnabled: true,
  allowReturningTrialPrice: true, ...overrides,
});
const shadow = overrides => resolveShadowPriceException(args(overrides));

test("returning pelvic trial-price question is independently verified after 48h follow-ups", () => {
  const verified = resolveReturningFirstTrialPriceService(args());
  assert.equal(verified?.name, "骨盆调理");
  assert.equal(shadow({allowReturningTrialPrice:false}), null,
    "old Shadow must not silently gain a seven-day session or change other clients");
  const decision = shadow();
  assert.equal(decision?.source, "customer_returning_first_trial");
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices.map(item => item.price), ["RM388", "RM288"]);

  const approval = resolveApprovedPricingAssessment({
    mode: "shadow", shadowException: decision, customerText: text,
    conversationHistory: returningHistory(), services, serviceAliases,
    resultMedia: [], now,
  });
  assert.equal(approval.reason, "approved");
  assert.equal(approval.decision?.treatment, "骨盆调理");
});

test("approved returning first-trial reply quotes both configured packages and selects both graphics", async () => {
  const decision = shadow();
  assert.ok(decision);
  const old = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {...old, assessmentFirstPricingEnabled:true};
  try {
    const quote = ensureVerifiedPriceReply({
      ...args(), reply:"我这边暂时无法核对准确金额，需要门店确认",
      treatment:decision.treatment, pricingDecision:decision,
      priceRequested:true, priceOnlyResponse:true,
      resultMedia: [], language:"zh",
    });
    assert.equal(quote.restored, true);
    assert.match(quote.reply, /Package A.*RM388/su);
    assert.match(quote.reply, /Package B.*RM288/su);

    const mediaArgs = {
      ...args(), priceQuery:true, packageQuery:false,
      aiPricingEnabled:true, pricingDecision:decision,
      treatment:"骨盆调理", verifiedServiceFromText:"骨盆调理",
      verifiedShadowPriceService:"骨盆调理",
      flagged:false, bookingReady:false, keywordReason:null,
      needsAttention:false, textSendSucceeded:true, contactId:98765,
      resultMedia:[], language:"zh",
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    };
    const selected = await resolvePricePromotionForReply(mediaArgs);
    assert.deepEqual(selected?.packages.map(item => item.name),["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...mediaArgs, wasPromoRecentlySent:async()=>true,
    }),null,"never resend a graphic when a verified duplicate exists");
    assert.equal(await resolvePricePromotionForReply({
      ...mediaArgs, hasUnconfirmedMediaDelivery:async()=>true,
    }),null,"never resend over an unconfirmed Meta media receipt");
  } finally {
    clinicConfig.automatedFollowUp = old;
  }
});

test("returning trial exception fails closed for staff, stale, untrusted and changed topics", () => {
  const fail = (history, question = text, extra = {}) => {
    assert.equal(shadow({
      conversationHistory: history, customerText: question, ...extra,
    }),null, question);
  };
  const staff = returningHistory();
  staff[4].pricingStaffAuthored = true;
  fail(staff);
  const staffText = returningHistory();
  staffText[4].content = "[Verified STAFF message] 已人工回复";
  fail(staffText);
  const anotherService = returningHistory();
  anotherService[4].content = "我们也有 3D 小颜术体验服务";
  fail(anotherService);
  const untrusted = returningHistory();
  delete untrusted[3].pricingCreatedAtMs;
  fail(untrusted);
  const reversed = returningHistory();
  reversed[3].pricingCreatedAtMs = now - 49 * HOUR;
  fail(reversed);
  const stale = returningHistory();
  stale[0].pricingCreatedAtMs = now - 8 * 24 * HOUR;
  fail(stale);
  const extraCustomer = returningHistory();
  extraCustomer.splice(6,0,turn("user","我想了解别的护理",30));
  fail(extraCustomer);
  const wrongService = returningHistory();
  wrongService[0].content = "Hi～我想了解3D 小颜术 和 骨盆调理";
  fail(wrongService);
  const noCustomerChoice = returningHistory();
  noCustomerChoice[0].content = "Hi～我想了解一下";
  fail(noCustomerChoice);
  const unacknowledged = returningHistory();
  unacknowledged[1].content = "我们有许多不同的疗程";
  fail(unacknowledged);
});

test("a trial mention is not enough to price an assessment, duration, refusal or new service", () => {
  for (const question of [
    "第一次体验需要多久呀", "第一次1对1体态评估+体验多少钱",
    "想问第一次免费评估的价格", "其他疗程第一次体验多少钱",
    "我不要第一次体验的价格", "全部项目第一次体验价钱是多少",
    "第一次体验会不会痛，价格是多少",
    "第一次体验的订金多少钱",
  ]) {
    const h=returningHistory();
    h[h.length-1].content=question;
    assert.equal(shadow({customerText:question,conversationHistory:h}),null,question);
  }
});
