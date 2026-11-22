"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { categorizeAiReview } = require("../src/utils/aiReviewPolicy");
const { campaignContextReply, firstReply, PREFILL } = require("../src/utils/neutroBreastRm68Campaign");

test("ordinary price, dates and location stay informational even if model says clinical", () => {
  for (const question of ["价钱呢？", "只有这两天？", "你们的店是在哪？"]) {
    assert.equal(categorizeAiReview(question, "clinical"), "information", question);
  }
});
test("genuine clinical enquiry still needs clinical review", () => {
  assert.equal(categorizeAiReview("乳腺癌可以做这个护理吗？", "information"), "clinical");
});
test("verified RM68 opener supports short date and price questions", () => {
  const history = [
    { role: "user", content: PREFILL },
    { role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z")) },
  ];
  for (const question of ["只有这两天？", "价钱呢？"]) {
    const answer = campaignContextReply({ history, customerText: question, now: Date.parse("2026-11-22T00:00:00Z") });
    assert.ok(answer && answer.includes("RM68"), question);
  }
});
test("campaign does not inherit price after treatment switch", () => {
  const history = [
    { role: "user", content: PREFILL },
    { role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z")) },
    { role: "user", content: "我想了解骨盆调理" },
    { role: "assistant", content: "好的" },
  ];
  assert.equal(campaignContextReply({ history, customerText: "价钱呢？", now: Date.parse("2026-11-22T00:00:00Z") }), null);
});


const { confirmedSingleBranchLocationAnswer } =
  require("../src/utils/verifiedPricingBusinessFacts");
const { administrativeReviewReply } =
  require("../src/utils/neutroAdministrativeReviewReply");

const PJ = [{
  name: "Petaling Jaya (PJ)",
  address: "C-12-6, Dataran 3 Two Business Centre, Jalan 19, Section 19/1, 46300 Petaling Jaya, Selangor",
}];

test("address is sourced from clinic settings, not an old Puchong location", () => {
  for (const [question, lang, part] of [
    ["你们的店是在哪？", "zh", "我们位于"],
    ["你们店在哪里?", "zh", "我们位于"],
    ["where are you located?", "en", "We're located"],
    ["boleh tahu alamat klinik?", "ms", "Kami berada"],
  ]) {
    const result = confirmedSingleBranchLocationAnswer({
      customerText: question, branches: PJ, language: lang,
    });
    assert.ok(result, question);
    assert.ok(result.reply.includes(PJ[0].address));
    assert.ok(result.reply.includes(part));
    assert.ok(!result.reply.includes("Puchong"));
  }
  const moved = [{name:"New Location",address:"Example Street, Malaysia"}];
  assert.match(confirmedSingleBranchLocationAnswer({
    customerText: "地址在哪里?", branches: moved,
  }).reply,/Example Street/);
});

test("do not infer business address for symptoms, unset or multiple branches", () => {
  assert.equal(confirmedSingleBranchLocationAnswer({
    customerText: "我的身体疼痛位置在哪里？", branches: PJ,
  }), null);
  assert.equal(confirmedSingleBranchLocationAnswer({
    customerText: "你们店在哪里?", branches: [],
  }), null);
  assert.equal(confirmedSingleBranchLocationAnswer({
    customerText: "你们店在哪里?", branches: [PJ[0], {name:"Other",address:"Other address"}],
  }), null);
});

test("plain price questions with no verified offer get a clarification", () => {
  const result = administrativeReviewReply({
    customerText:"价钱呢？", history:[], branches:PJ, language:"zh",
    services:[],serviceAliases:[],promotions:[],
  });
  assert.equal(result?.kind,"unscoped_price_clarification");
  assert.match(result.reply,/哪一项护理/);
  assert.ok(!/RM\s*[0-9]/u.test(result.reply));
});

test("alternative dates do not inherit the event-only RM68 price", () => {
  const history = [
    {role:"user",content:PREFILL},
    {role:"assistant",content:firstReply(Date.parse("2026-11-22T00:00:00Z"))},
    {role:"user",content:"因为刚好这两天我不在kl😭"},
    {role:"assistant",content:"我们平日也有草药胸部护理，可以帮你确认其他日期"},
  ];
  const result = administrativeReviewReply({
    customerText:"价钱呢？", history, branches:PJ, language:"zh",
    now:Date.parse("2026-11-22T00:00:00Z"),
  });
  assert.equal(result?.kind,"verified_rm68_campaign");
  assert.match(result.reply,/其他日期/);
  assert.match(result.reply,/收费需要先请门店确认/);
  assert.doesNotMatch(result.reply,/其他日期.{0,50}RM68 活动价适用/);
});

test("clinical concerns do not get administrative answers from medical location", () => {
  const result = administrativeReviewReply({
    customerText:"乳腺癌适合吗？", history:[], branches:PJ,
    language:"zh",
  });
  assert.equal(result,null);
});
