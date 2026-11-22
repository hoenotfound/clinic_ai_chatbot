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


const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

function serverSection(start, end) {
  const a = serverSource.indexOf(start);
  const b = serverSource.indexOf(end, a);
  assert.ok(a > 0 && b > a, "Expected real server boundaries");
  return serverSource.slice(a, b);
}

const adminRecoverySection = serverSection(
  "    // Recover routine location, verified campaign/date, and unscoped price",
  "    // A non-urgent urinary symptom merits one staff review"
);

async function runRealRecoveryBoundary({ pending, sender = 1 }) {
  const history = [
    { role: "user", content: PREFILL },
    { role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z")) },
  ];
  const context = {
    keywordReason: null, urgentSafety: false, flagged: true, reviewRequired: true,
    reviewType: "clinical", bookingReady: false, text: "价钱呢？",
    marketingStopQuestion: null, clinicalAcknowledgement: null,
    priceQuery: true, packageQuery: true, serviceQuery: true,
    serviceQuerySource: "model", details: null,
    reply: "AI draft under review", reviewContinuationTextOnly: false,
    channel: "whatsapp", history, mediaLanguage: "zh",
    contact: { id: 24, whatsapp_sender_id: sender },
    savedInbound: { id: 999 },
    clinicConfig: {
      businessType: "tcm_clinic", businessName: "Neutro Sense TCM Centre",
      branches: PJ, services: [], serviceAliases: [], promotions: [],
    },
    isActiveSafetyConcern: () => false,
    hasClinicalMediaRisk: () => false,
    isExplicitStaffRequest: () => false,
    isDefiniteAppointmentCancellation: () => false,
    administrativeReviewReply,
    contactsRepo: {
      getTcmReviewEvidence: async () => pending === null ? null :
        { pendingClinicalReview: pending },
    },
    console: { info: () => {} },
  };
  const code = "(async () => {\n" + adminRecoverySection +
    "\nreturn {flagged,reviewRequired,reply,reviewContinuationTextOnly};\n})()";
  return await vm.runInNewContext(code, context);
}

test("real server boundary never bypasses pending or unknown clinical reviews", async () => {
  for (const sender of [1, 2]) {
    for (const pending of [true, null]) {
      const result = await runRealRecoveryBoundary({pending, sender});
      assert.equal(result.flagged, true);
      assert.equal(result.reviewRequired, true);
      assert.equal(result.reply, "AI draft under review");
    }
    const result = await runRealRecoveryBoundary({pending:false, sender});
    assert.equal(result.flagged,false);
    assert.equal(result.reviewRequired,false);
    assert.equal(result.reviewContinuationTextOnly,true);
    assert.match(result.reply,/RM68/);
  }
});

const finalLocationSection = serverSection(
  "    // A location-only enquiry must never depend on the model's invented",
  "    responseAttempted = true;"
);
test("real final-send guard replaces Puchong on both sender paths", async () => {
  for (const sender of [1, 2]) {
    const context = {
      flagged:false, bookingReady:false, keywordReason:null,
      marketingStopQuestion:null, urgentSafety:false,
      text:"你们的店是在哪？", reply:"我们的店在 Puchong。",
      channel:"whatsapp", mediaLanguage:"zh", reviewContinuationTextOnly:false,
      priceQuery:false, packageQuery:false, serviceQuery:false,
      serviceQuerySource:null,
      contact:{id:24,whatsapp_sender_id:sender},
      clinicConfig:{businessType:"tcm_clinic",
        businessName:"Neutro Sense TCM Centre",branches:PJ},
      isActiveSafetyConcern:()=>false, hasClinicalMediaRisk:()=>false,
      isExplicitStaffRequest:()=>false,confirmedSingleBranchLocationAnswer,
    };
    const result = await vm.runInNewContext(
      "(async()=>{\n" + finalLocationSection +
      "\nreturn {reply,reviewContinuationTextOnly};\n})()", context
    );
    assert.ok(result.reply.includes(PJ[0].address));
    assert.doesNotMatch(result.reply,/Puchong/);
    assert.equal(result.reviewContinuationTextOnly,true);
  }
});


test("mixed price and address questions include PJ without guessing a new price", () => {
  const withoutCampaign = administrativeReviewReply({
    customerText: "价钱呢？你们店在哪里？",
    history: [], branches: PJ, language: "zh", services: [],
    serviceAliases: [], promotions: [],
  });
  assert.equal(withoutCampaign?.kind, "mixed_price_location_clarification");
  assert.match(withoutCampaign.reply, /哪一项护理/);
  assert.ok(withoutCampaign.reply.includes(PJ[0].address));
  assert.doesNotMatch(withoutCampaign.reply, /Puchong|RM\s*\d+/);

  const withCampaign = administrativeReviewReply({
    customerText: "价钱呢？你们店在哪里？",
    history: [
      {role: "user", content: PREFILL},
      {role: "assistant", content: firstReply(Date.parse("2026-11-22T00:00:00Z"))},
    ],
    branches: PJ, language: "zh",
    services: [], serviceAliases: [], promotions: [],
    now: Date.parse("2026-11-22T00:00:00Z"),
  });
  assert.equal(withCampaign?.kind, "verified_rm68_campaign");
  assert.match(withCampaign.reply, /RM68/);
  assert.ok(withCampaign.reply.includes(PJ[0].address));
});

test("explicit English location overrides old Malay language preference", () => {
  const reply = confirmedSingleBranchLocationAnswer({
    customerText: "where are you located?", language: "ms", branches: PJ,
  })?.reply;
  assert.match(reply, /We're located/);
  assert.doesNotMatch(reply, /Kami berada/);
});

const { planNeutroReviewContinuation } =
  require("../src/utils/neutroReviewContinuation");
test("natural short price questions are recognized even when no safe offer can be inferred", () => {
  for (const question of ["价钱？", "价钱呢？", "价格呢？"]) {
    const result = planNeutroReviewContinuation({
      customerText: question, conversationHistory: [],
      language: "zh", services: [], serviceAliases: [], promotions: [],
    });
    assert.equal(result?.kind, "unscoped_price_clarification", question);
  }
});

const oldContinuitySection = serverSection(
  "    // Recover only narrow, non-clinical continuations wrongly escalated",
  "    // An RM68 campaign slot enquiry is answerable"
);
test("older verified-price review path never clears pending clinical review", async () => {
  for (const pending of [true, false, null]) {
    const context = {
      flagged: true, reviewRequired: true, reviewType: "clinical",
      keywordReason: null, urgentSafety: false, marketingStopQuestion: null,
      text: "价钱？", bookingReady: false, reply: "staff review",
      serviceQuery: true, serviceQuerySource: "model", priceQuery: true,
      packageQuery: false, details: null, clinicalAcknowledgement: null,
      reviewContinuationTextOnly: false, channel: "whatsapp",
      mediaLanguage: "zh", history: [],
      contact: {id: 1}, savedInbound: {id: 101},
      clinicConfig: {businessType: "tcm_clinic", businessName: "Neutro Sense TCM Centre",
        services: [], serviceAliases: [], promotions: []},
      isActiveSafetyConcern: () => false,
      hasClinicalMediaRisk: () => false,
      isExplicitStaffRequest: () => false,
      planNeutroReviewContinuation: () => ({kind: "verified_price", reply:"verified reply"}),
      contactsRepo: {getTcmReviewEvidence: async () => pending === null ? null :
        {pendingClinicalReview: pending}},
      console: {info: () => {}},
    };
    const result = await vm.runInNewContext(
      "(async()=>{\n" + oldContinuitySection +
      "\nreturn {flagged,reviewRequired,reply,reviewContinuationTextOnly};\n})()", context
    );
    assert.equal(result.flagged, pending !== false);
    assert.equal(result.reviewRequired, pending !== false);
    assert.equal(result.reviewContinuationTextOnly, pending === false);
  }
});

const earlyPriceSection = serverSection(
  "    // Recover an unambiguous, customer-authored price question early enough",
  "    if (aiPricingEnabled &&\n        flagged"
);
test("verified price review flows to existing pricing/media path only without clinical hold", async () => {
  for (const sender of [1, 2]) {
    for (const pending of [true, false, null]) {
      const context = {
        flagged: true, reviewRequired: true, reviewType: "clinical",
        keywordReason: null, urgentSafety: false, bookingReady: false,
        marketingStopQuestion: null, text: "价钱呢？",
        aiPricingEnabled: true, aiPricingMode: "enabled",
        priceQuery: false, packageQuery: false, details: null,
        aiReply: "review draft", mediaLanguage: "zh",
        channel: "whatsapp", contact: {id:7, whatsapp_sender_id:sender},
        savedInbound: {id:99}, history: [],
        clinicConfig: {businessType: "tcm_clinic", businessName: "Neutro Sense TCM Centre",
          services: [{name:"骨盆调理"}], serviceAliases: [], promotions: []},
        isActiveSafetyConcern: () => false, hasClinicalMediaRisk: () => false,
        isExplicitStaffRequest: () => false,
        isDefiniteAppointmentCancellation: () => false,
        isStandaloneNeutroPriceQuestion: () => true, hasExplicitPriceRequest: () => true,
        categorizeAiReview: () => "information", campaignContextReply: () => null,
        resolveVerifiedPriceFollowUpService: () => ({name:"骨盆调理"}),
        planNeutroReviewContinuation: () => null,
        verifiedPricesForService: () => [
          {name:"Package A",price:"RM388"},{name:"Package B",price:"RM268"},
        ],
        contactsRepo: {getTcmReviewEvidence: async () => pending === null ? null :
          {pendingClinicalReview:pending}},
        priceCheckingReply: () => "checking verified prices",
        console: {info: () => {}},
      };
      const result = await vm.runInNewContext(
        "(async()=>{\n" + earlyPriceSection +
        "\nreturn {flagged,reviewRequired,priceQuery,details,aiReply};\n})()", context
      );
      assert.equal(result.flagged, pending !== false);
      assert.equal(result.reviewRequired, pending !== false);
      assert.equal(result.priceQuery, pending === false);
      if (pending === false) {
        assert.equal(result.details.treatment,"骨盆调理");
        assert.equal(result.aiReply,"checking verified prices");
      }
    }
  }
});


test("latest English and Malay admin questions override older chat-language labels", () => {
  const en = administrativeReviewReply({
    customerText: "price?", history: [], branches: PJ,
    language: "ms", services: [], serviceAliases: [], promotions: [],
  });
  assert.match(en.reply, /Which treatment would you like/);
  const ms = administrativeReviewReply({
    customerText: "berapa harga", history: [], branches: PJ,
    language: "en", services: [], serviceAliases: [], promotions: [],
  });
  assert.match(ms.reply, /Awak nak tahu harga/);
});

test("natural price helper accepts 价钱呢 but rejects unrelated text", () => {
  const { isStandalonePriceQuestion } =
    require("../src/utils/neutroAdministrativeReviewReply");
  assert.equal(isStandalonePriceQuestion("价钱呢？"), true);
  assert.equal(isStandalonePriceQuestion("价钱？"), true);
  assert.equal(isStandalonePriceQuestion("有没有疼痛？"), false);
});
