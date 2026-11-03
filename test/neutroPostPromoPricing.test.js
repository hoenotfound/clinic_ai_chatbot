"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createNeutroSubsequentPricingService,
  packageSuggestionVariants,
  staffPriceReference,
} = require("../src/services/neutroSubsequentPricingService");
const { resolveRepeatVisitPriceReply } = require("../src/utils/repeatVisitPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const now = Date.parse("2026-11-03T11:20:00Z");
const services = [
  { name: "3D 小颜术", priceRange: "Normal Price RM888; promotional amount from active promotions" },
  { name: "9D 逆龄抗衰", priceRange: "Normal Price RM1,288; promotional amount from active promotions" },
  { name: "3D + 9D 组合", priceRange: "" },
];
const serviceAliases = [
  { alias: "3D小颜术", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
];
const promotions = [
  { name: "3D First Trial", linkedService: "3D 小颜术", sendOnPriceQuery: true,
    imageUrl: "https://example.test/promo-images/32", caption: "3D First Trial RM488",
    pricing: { offer: 488, normal: 888, currency: "MYR" },
    validFrom: "2026-10-01", validUntil: "2026-11-30",
    mediaTranslations: { en: {imageUrl: "https://example.test/promo-images/33"} } },
  { name: "9D First Trial", linkedService: "9D 逆龄抗衰", sendOnPriceQuery: true,
    imageUrl: "https://example.test/promo-images/21", caption: "9D First Trial RM488",
    pricing: { offer: 488, normal: 1288, currency: "MYR" },
    validFrom: "2026-10-01", validUntil: "2026-11-30" },
  { name: "3D+9D Combination", linkedService: "3D + 9D 组合", sendOnPriceQuery: true,
    imageUrl: "https://example.test/promo-images/22", caption: "RM688",
    validFrom: "2026-10-01", validUntil: "2026-11-30" },
];
const thread = text => [
  {role: "user", content: "3D 小颜术", pricingCreatedAtMs: now - 60000},
  {role: "assistant", content: "我介绍一下3D 小颜术", pricingCreatedAtMs: now - 30000},
  {role: "user", content: text, pricingCreatedAtMs: now - 1000},
];
const params = (text = "第二次收费多少", changes = {}) => ({
  contactId: 45, inboundMessageId: 99, customerText: text,
  conversationHistory: thread(text), services, serviceAliases,
  promotions, language: "zh", now, ...changes,
});

test("No matching accepted First Trial graphic means NO package sales suggestion or staff escalation", async () => {
  let stageLookups = 0;
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async () => false,
    hasRecentAcceptedPackageSuggestion: async () => { stageLookups++; return true; },
  });
  const outcome = await resolve(params());
  assert.equal(outcome.mode, "before_promo");
  assert.match(outcome.reply, /First Trial|体验优惠/u);
  assert.doesNotMatch(outcome.reply, /RM\s*488|RM\s*888|配套选择/u);
  assert.equal(stageLookups, 0);
});

test("Accepted same-service First Trial graphic starts with ONE package invitation, not the regular price", async () => {
  const lookedUp = [];
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (id, url, hours) => {
      lookedUp.push({id,url,hours});
      return url.endsWith("/32");
    },
    hasRecentAcceptedPackageSuggestion: async () => false,
  });
  const result = await resolve(params());
  assert.equal(result.mode, "suggest_package");
  assert.match(result.reply, /3D 小颜术/u);
  assert.match(result.reply, /配套/u);
  assert.doesNotMatch(result.reply, /RM488|RM888|RM1,288/u);
  assert.ok(lookedUp.some(x => x.id === 45 && x.hours === 168 && x.url.endsWith("/32")));
});

test("Repeated later-session price request AFTER an accepted package pitch hands to staff", async () => {
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async () => true,
    hasRecentAcceptedPackageSuggestion: async (contactId, replies, inboundId) => {
      assert.equal(contactId, 45);
      assert.equal(inboundId, 99);
      assert.deepEqual(replies, packageSuggestionVariants("3D 小颜术"));
      return true;
    },
  });
  const response = await resolve(params("不需要配套，我只想知道3D 小颜术第二次多少钱", {
    conversationHistory: thread("不需要配套，我只想知道3D 小颜术第二次多少钱")
  }));
  assert.equal(response?.mode, "staff_handoff");
  assert.match(response.reply, /同事/u);
  assert.match(response.staffReason, /RM888/u);
  assert.doesNotMatch(response.reply, /RM888|RM488/u);
});

test("Wrong-service graphic and combined graphic never authorize 3D subsequent-session package flow", async () => {
  const checked = [];
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (_,url) => {
      checked.push(url);
      return url.includes("/21") || url.includes("/22");
    },
    hasRecentAcceptedPackageSuggestion: async () => true,
  });
  const result = await resolve(params());
  assert.equal(result.mode, "before_promo");
  assert.ok(checked.every(url => !url.includes("/21") && !url.includes("/22")));
});

test("Matching translated graphic variant qualifies without cross-treatment price leakage", async () => {
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (_,url) => url.includes("/33"),
    hasRecentAcceptedPackageSuggestion: async () => false,
  });
  const result = await resolve(params("3D 小颜术第二次多少钱", {
    conversationHistory: [{role:"user",content:"3D 小颜术第二次多少钱",pricingCreatedAtMs:now-1000}],
    language: "en",
  }));
  assert.equal(result?.mode, "suggest_package");
  assert.match(result.reply, /multi-session/u);
  assert.doesNotMatch(result.reply, /RM888|RM488/u);
});

test("Direct 9D subsequent-session request uses the 9D graphic and internal RM1,288 reference", async () => {
  const resolvedUrls = [];
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (_,url) => { resolvedUrls.push(url); return url.endsWith("/21"); },
    hasRecentAcceptedPackageSuggestion: async () => true,
  });
  const question = "9D 第二次价格多少";
  const result = await resolve(params(question, {
    conversationHistory: [{role:"user",content:question,pricingCreatedAtMs:now-1000}],
  }));
  assert.equal(result?.mode, "staff_handoff");
  assert.match(result.staffReason, /RM1,288/u);
  assert.doesNotMatch(result.reply, /RM1,288/u);
  assert.deepEqual(resolvedUrls, ["https://example.test/promo-images/21"]);
});

test("First Trial quotation and general service enquiry never activate repeat-session handling", async () => {
  let mediaCalled = 0;
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async () => {mediaCalled++; return true;},
    hasRecentAcceptedPackageSuggestion: async () => true,
  });
  for (const text of ["3D 小颜术多少钱", "9D First Trial RM488?", "有个预算",
    "3D 和 9D 第二次多少钱", "我想预约3D 小颜术"]) {
    const result = await resolve(params(text, {
      conversationHistory: [{role:"user",content:text,pricingCreatedAtMs:now-1000}],
    }));
    assert.equal(result, null, text);
  }
  assert.equal(mediaCalled, 0);
});

test("Unsafe or staff-owned treatment history cannot initiate package-first messages", async () => {
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async () => true,
    hasRecentAcceptedPackageSuggestion: async () => true,
  });
  const q = "第二次收费多少";
  const withStaff = [ ...thread(q).slice(0,-1),
    {role:"assistant",content:"[Verified STAFF message] Price discussed",pricingStaffAuthored:true,pricingCreatedAtMs:now-2000},
    {role:"user",content:q,pricingCreatedAtMs:now-1000}];
  assert.equal(await resolve(params(q,{conversationHistory:withStaff})), null);
  assert.equal(staffPriceReference("3D 小颜术",services),"RM888");
  assert.equal(staffPriceReference("9D 逆龄抗衰",services),"RM1,288");
});

test("Source routing is sender-owned: checks use the supplied contact, not customer phone/ad identity", async () => {
  const seen=[];
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (contactId,url) => {
      seen.push([contactId,url]);
      return contactId === 7;
    },
    hasRecentAcceptedPackageSuggestion: async () => false,
  });
  const primary=await resolve(params(undefined,{contactId:7}));
  const secondary=await resolve(params(undefined,{contactId:8}));
  assert.equal(primary.mode,"suggest_package");
  assert.equal(secondary.mode,"before_promo");
  assert.equal(seen[0][0],7);
  assert.ok(seen.some(([id]) => id===8));
});


test("A bare follow-up price question after an accepted package suggestion still reaches staff", async () => {
  const checked = [];
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async (_,url) => url.endsWith("/32"),
    hasRecentAcceptedPackageSuggestion: async (_,messages) => {
      checked.push(messages[0]);
      return messages.some(x => x.includes("3D 小颜术"));
    },
  });
  for (const q of ["But how much?", "What's the normal price?", "单次多少钱"]) {
    const outcome = await resolve(params(q, {
      conversationHistory: [{role:"user",content:q,pricingCreatedAtMs:now-1000}],
      language:"en",
    }));
    assert.equal(outcome?.mode,"staff_handoff",q);
    assert.match(outcome.staffReason,/RM888/u);
    assert.doesNotMatch(outcome.reply,/RM888|RM488/u);
  }
  assert.ok(checked.length>=3);
});

test("First Trial and package price questions do not become persistent single-session enquiries", async () => {
  let escalations = 0;
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async () => true,
    hasRecentAcceptedPackageSuggestion: async () => {
      escalations++;
      return true;
    },
  });
  for(const question of ["3D 小颜术多少钱", "Can you resend the First Trial promo price?",
    "How much is the 3D package?", "RM488 是体验价吗？"]) {
    const outcome = await resolve(params(question, {
      conversationHistory:[{role:"user",content:question,pricingCreatedAtMs:now-1000}],
    }));
    assert.equal(outcome,null,question);
  }
  assert.equal(escalations,0);
});

test("English second-session question with how much and no literal price word is caught", async () => {
  const q="How much for the second session of 3D 小颜术?";
  const resolve = createNeutroSubsequentPricingService({
    wasMediaRecentlySent: async ()=>true,
    hasRecentAcceptedPackageSuggestion: async ()=>false,
  });
  const outcome=await resolve(params(q, {
    conversationHistory:[{role:"user",content:q,pricingCreatedAtMs:now-1000}],
    language:"en",
  }));
  assert.equal(outcome?.mode,"suggest_package");
  assert.doesNotMatch(outcome.reply,/RM888|RM488/u);
});

test("The generated package pitch can be matched exactly in the accepted-message lookup", () => {
  const texts = packageSuggestionVariants("3D 小颜术");
  assert.equal(new Set(texts).size,3);
  assert.ok(texts.every(text => text.includes("3D 小颜术")));
  assert.ok(texts.every(text => !/RM\s*(?:488|888|1,288)/u.test(text)));
});


function firstTrialImageParams(treatment = "3D 小颜术", customerText = "第二次收费多少", overrides = {}) {
  return {
    priceQuery: false,
    packageQuery: false,
    // This is a separately verified repeat-session request, not an AI model
    // estimate of the price. Both routes enter the SAME promotion selector.
    verifiedSubsequentTrialService: treatment,
    treatment,
    verifiedServiceFromText: treatment,
    aiPricingEnabled: true,
    pricingDecision: null,
    customerText,
    conversationHistory: thread(customerText),
    flagged: false,
    bookingReady: false,
    keywordReason: null,
    needsAttention: false,
    textSendSucceeded: true,
    promotions,
    services,
    serviceAliases,
    resultMedia: [],
    language: "zh",
    contactId: 45,
    duplicateWindowHours: 168,
    now: new Date(now),
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    ...overrides,
  };
}

test("Repeat-session 3D and 9D graphics use the same selector as ordinary pricing", async () => {
  const checks = [];
  const threeD = await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术", "3D 小颜术第二次收费多少",
    { language: "en", wasPromoRecentlySent: async (id,url,caption,hours) => {
      checks.push({ id,url,caption,hours });
      return false;
    }}
  ));
  assert.equal(threeD?.promotion?.name, "3D First Trial");
  assert.equal(threeD?.packages[0]?.imageUrl, "https://example.test/promo-images/33");
  assert.deepEqual(new Set(checks.map(x=>x.url)), new Set([
    "https://example.test/promo-images/32",
    "https://example.test/promo-images/33",
  ]));
  assert.ok(checks.every(x=>x.id===45&&x.hours===168));
  const nineD = await resolvePricePromotionForReply(firstTrialImageParams(
    "9D 逆龄抗衰", "9D 第二次价格多少",
    { language: "ms" }
  ));
  assert.equal(nineD?.promotion?.name,"9D First Trial");
  assert.equal(nineD?.packages[0]?.imageUrl,"https://example.test/promo-images/21");
});

test("An accepted image in another language or an unconfirmed send blocks another graphic", async () => {
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术", "第二次收费多少",
    {wasPromoRecentlySent:async (_,url)=>url.endsWith("/33")}
  )),null);
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术", "第二次收费多少",
    {hasUnconfirmedMediaDelivery:async (_,url)=>url.endsWith("/33")}
  )),null);
});

test("Current promotion validity, manual hold and ambiguous packages still control repeat-session graphics", async () => {
  const paused = promotions.map(p=>p.linkedService==="3D 小颜术"
    ? {...p,automaticMediaHold:true}:p);
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术", "第二次收费多少",{promotions:paused}
  )),null,"manually paused campaign");
  const expired = promotions.map(p=>p.linkedService==="9D 逆龄抗衰"
    ? {...p,validUntil:"2026-10-01"}:p);
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "9D 逆龄抗衰", "9D 第二次收费多少",{promotions:expired}
  )),null,"expired campaign");
  const ambiguous = promotions.map(p=>p.linkedService==="3D 小颜术"
    ? {...p,packages:[
        {name:"First Trial A",imageUrl:p.imageUrl,caption:"Trial A"},
        {name:"First Trial B",imageUrl:"https://example.test/other",caption:"Trial B"},
      ]}:p);
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术", "第二次收费多少",{promotions:ambiguous}
  )),null,"no arbitrary choice among multiple price graphics");
});

test("No accepted text, no AI ownership or no explicit price request means no repeat-session promo", async () => {
  for (const changes of [
    {textSendSucceeded:false},
    {needsAttention:true},
    {flagged:true},
    {bookingReady:true},
    {keywordReason:"opt_out"},
    {contactId:null},
    {customerText:"3D 小颜术治疗是怎样的"},
    {verifiedSubsequentTrialService:"9D 逆龄抗衰"},
  ]) {
    const result=await resolvePricePromotionForReply(firstTrialImageParams(
      "3D 小颜术", "3D 第二次收费多少",changes
    ));
    assert.equal(result,null,JSON.stringify(changes));
  }
});

test("Ordinary first-trial and combination promo routing never relies on the repeat-session exception", async () => {
  let skipReason;
  const withoutException=await resolvePricePromotionForReply(firstTrialImageParams(
    "3D 小颜术","3D 小颜术第二次收费多少",
    {verifiedSubsequentTrialService:null,onSkip:reason=>skipReason=reason}
  ));
  assert.equal(withoutException,null);
  assert.equal(skipReason,"no_approved_pricing_decision");
  // The classifier never verifies combo graphics as a standalone 3D/9D
  // second-session enquiry. Without that verified signal, existing combo
  // price-media authority still applies and cannot be bypassed.
  assert.equal(await resolvePricePromotionForReply(firstTrialImageParams(
    "3D + 9D 组合","3D 和 9D 第二次收费多少",
    {verifiedSubsequentTrialService:null}
  )),null,"no new combo or cross-treatment permission");
});

test("Server uses only the original promotion selector and queue for First Trial follow-up graphics", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../src/server.js"),"utf8");
  assert.ok(source.includes('verifiedSubsequentTrialService: repeatVisitPriceReply?.mode === "before_promo"'));
  assert.ok(source.includes('repeatVisitPriceReply.mode !== "before_promo"'));
  assert.equal(source.includes("resolveNeutroFirstTrialPromotion"),false);
  assert.ok(source.includes("resolvePricePromotionForReply({"));
  assert.ok(source.indexOf("resolvePricePromotionForReply({") <
    source.indexOf("const pacedPromotions = planPromotionMediaPacing(promoBundle.packages)"));
  assert.ok(source.includes("secondaryAiConversation ? secondaryAiMediaQueue : whatsappResultMediaQueue"));
  assert.ok(source.includes('channel === "whatsapp" && /^neutro'));
});
