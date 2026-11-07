"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { recentVerifiedPricingSession } = require("../src/utils/shadowPriceException");
const { recentConversationServiceAnchor, serviceCandidates } = require("../src/utils/conversationPromptContext");
const { resolveFacialCategoryPriceReply } = require("../src/utils/priceConversationRecovery");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");
const { resolveNeutroFacialDeviceReview } = require("../src/utils/neutroFacialDeviceReview");
const { categorizeAiReview } = require("../src/utils/aiReviewPolicy");

const now = Date.now();
const turn = (role, content, age = 0, staff = false) => ({
  role, content, pricingCreatedAtMs: now - age * 1000, pricingStaffAuthored: staff,
});
const services = [
  { name: "骨盆调理" }, { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" }, { name: "3D + 9D 组合" },
];
const aliases = [
  { alias: "Pelvis", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "3D+9D", officialService: "3D + 9D 组合" },
];
const promotions = [
  { name: "3D 小颜术 First Trial", linkedService: "3D 小颜术",
    sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
    pricing: {currency: "MYR", offer: 488, normal: 888},
    caption: "3D 小颜术 First Trial 原价 RM888 优惠价 RM488" },
  { name: "9D 逆龄抗衰 First Trial", linkedService: "9D 逆龄抗衰",
    sendOnPriceQuery: true, validFrom: "2000-01-01", validUntil: "2999-12-31",
    pricing: {currency: "MYR", offer: 488, normal: 1288},
    caption: "9D 逆龄抗衰 First Trial 原价 RM1288 优惠价 RM488" },
];
const welcome = "Hi! Are you looking for facial care, body posture/pelvis, or postpartum conditioning?";
const facialMenu = "For facial care, we mainly have two directions:\n" +
  "1. 3D 小颜术: A manual facial contour care focusing on jawline definition.\n" +
  "2. 9D 逆龄抗衰: A device-based firming and lifting care.\n" +
  "Which concern are you hoping to improve more?";
const thread = [
  turn("user", "Hi", 75),
  turn("assistant", welcome, 70),
  turn("user", "facial care", 55),
  turn("assistant", facialMenu, 48),
  turn("user", "how much", 40),
];
const dual = (history, current = "how much", offered = promotions) =>
  resolveFacialCategoryPriceReply({
    customerText: current, session: recentVerifiedPricingSession(history, current, now),
    services, serviceAliases: aliases, promotions: offered, language: "en", now,
  });

test("contact 8957: facial care is a customer topic boundary, not welcome-menu pelvic selection", () => {
  const anchor = recentConversationServiceAnchor(
    thread, serviceCandidates(services, aliases), 16, promotions
  );
  assert.equal(anchor.serviceSource, "recent_broad_context");
  assert.deepEqual(anchor.relevantServiceNames, []);
  const fallback = guardAssessmentFirstPricingReply({
    customerText: "how much", reply: "The rate is RM388",
    conversationHistory: thread, isFirstMessage: false,
    services, serviceAliases: aliases, promotions, language: "en",
    requireVerifiedTreatment: true, treatment: null,
  });
  assert.equal(fallback.replaced, true);
  assert.doesNotMatch(fallback.reply, /骨盆|pelv|RM388/iu);
});

test("contact 8957: immediate 'how much' after a verified 3D/9D facial menu quotes two separate RM488 trials", () => {
  const result = dual(thread);
  assert.equal(result?.source, "verified_facial_category_two_offers");
  assert.deepEqual(result?.prices.map(x => [x.treatment, x.amount]), [
    ["3D 小颜术", "RM488"], ["9D 逆龄抗衰", "RM488"],
  ]);
  assert.match(result.reply, /3D/u);
  assert.match(result.reply, /9D/u);
  assert.match(result.reply, /RM488/u);
  assert.doesNotMatch(result.reply, /RM688|组合|骨盆/iu);
});

test("facial category pricing fails closed for stale, unrelated, or unsafe context", () => {
  const cases = [
    [...thread.slice(0,-2), turn("assistant", "We offer pelvic packages A and B", 48), turn("user","how much",40)],
    [...thread.slice(0,-1), turn("user","how much for the combo",40)],
    [...thread.slice(0,-1), turn("user","how much for my second session?",40)],
    [...thread.slice(0,-2), turn("assistant","3D 小颜术 starts with a consultation",48), turn("user","how much",40)],
    [...thread.slice(0,-2), turn("assistant",facialMenu,48,true), turn("user","how much",40)],
    [...thread.slice(0,-2), turn("assistant",facialMenu,4*60*60), turn("user","how much",40)],
    [turn("user", "What services?", 55), turn("assistant", facialMenu,48),turn("user","how much",40)],
  ];
  for (const history of cases) {
    const current = history.at(-1).content;
    assert.equal(dual(history,current),null,current);
  }
  assert.equal(dual(thread,"how much",[promotions[0]]),null);
  assert.equal(dual(thread,"how much",[
    promotions[0],{...promotions[1],validUntil:"2001-01-01"},
  ]),null);
  assert.equal(dual(thread,"how much",[
    promotions[0],{...promotions[1],pricing:{currency:"MYR",offer:999,normal:1288}},
  ]),null);
});

test("technical 9D device questions receive safe information-review acknowledgement", () => {
  const base = [
    turn("user","facial care",120),
    turn("assistant",facialMenu,110),
    turn("user","do u do filler?",100),
    turn("assistant","No injections. 3D is manual and 9D is device-based firming care.",90),
  ];
  const first = [...base,turn("user","what device",80)];
  const second = [...first,turn("user","which device u use?",70)];
  for (const history of [first,second]) {
    const decision = resolveNeutroFacialDeviceReview({
      customerText:history.at(-1).content,
      conversationHistory:history,services,language:"en",now,
    });
    assert.equal(decision?.reviewType,"information");
    assert.match(decision?.reply,/device.*verified brand|verified brand/iu);
    assert.match(decision?.reply,/team.*confirm/iu);
    assert.doesNotMatch(decision?.reply,/HIFU|Ultherapy|RF|品牌是|型号是/iu);
  }
  assert.equal(categorizeAiReview("what device","information"),"information");
  assert.equal(categorizeAiReview("which device u use?","information"),"information");
});

test("device review cannot override staff, clinical risk, or unrelated treatment discussions", () => {
  const prior = [turn("user","facial care",70),turn("assistant","9D is device-based",60)];
  const ask = content => [...prior,turn("user",content,40)];
  assert.equal(resolveNeutroFacialDeviceReview({
    customerText:"is this device safe during pregnancy?",
    conversationHistory:ask("is this device safe during pregnancy?"),services,now,
  }),null);
  assert.equal(resolveNeutroFacialDeviceReview({
    customerText:"what device",
    conversationHistory:[
      turn("user","pelvic",70),turn("assistant","Pelvic treatment is manual.",60),
      turn("user","what device",40),
    ],services,now,
  }),null);
  assert.equal(resolveNeutroFacialDeviceReview({
    customerText:"what device",
    conversationHistory:[
      turn("user","facial care",70),turn("assistant","9D is device-based",60,true),
      turn("user","what device",40),
    ],services,now,
  }),null);
  assert.equal(categorizeAiReview("Is the device safe during pregnancy?", "information"),"clinical");
});

test("server keeps dual offers text-only and the device acknowledgement on the guarded send path", () => {
  const server = fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  assert.match(server,/resolveFacialCategoryPriceReply\(/u);
  assert.match(server,/if \(twoTreatmentQuote\) \{[\s\S]{0,500}reply = twoTreatmentQuote\.reply/u);
  assert.match(server,/if \(flagged && reviewRequired\) \{[\s\S]{0,550}setAiReviewAttention\(/u);
  assert.match(server,/await auditResultMediaEarlyExit\("two_treatments_text_only"\);/u);
  assert.match(server,/clinicalAcknowledgement = deviceReview\.reply/u);
  assert.match(server,/await sendTrackedText\(/u);
});
