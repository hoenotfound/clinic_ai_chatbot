"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { buildSystemPrompt, buildFollowUpPrompt } = require("../src/utils/systemPrompt");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

async function withConfig(overrides, fn) {
  const saved = structuredClone(config);
  try {
    Object.assign(config, overrides);
    return await fn();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
}

const pulseDescription = [
  "脉冲波调理结合中医调理理念与现代设备辅助护理。",
  "常见咨询方向：局部线条管理（肚子、腰、臀、腿）、中医智能减脂类体态管理、产后身体及骨盆护理需求、",
  "肌肉紧绷僵硬疲劳的放松、经络养生和水肿困扰。",
  "护理适用性与个人变化由中医师评估，不能保证减脂、纠正骨盆、消肿或治疗疾病。",
].join("");

function fixture() {
  return {
    aiAssistantName: "Clinic helper",
    businessName: "Pulse Test Clinic",
    clinicName: "Pulse Test Clinic",
    businessType: "tcm_clinic",
    businessDescription: "Body-care consultations",
    services: [
      {name: "骨盆调理", description: "Manual pelvic care only", duration: "TBD", priceRange: ""},
      {name: "脉冲波调理", description: pulseDescription, duration: "First-trial combined visit 2h15 including complimentary care", priceRange: ""},
    ],
    serviceAliases: [{alias: "pulse wave", officialService: "脉冲波调理"}],
    messagingStyle: "Speak naturally and ask one question; match the customer's language.",
    sop: "脉冲波调理｜说明原则\nDo not claim 15cm tissue penetration or treatment of gynecological disease.",
    promotions: [
      {name: "Pulse trial", linkedService: "脉冲波调理", caption: "First Trial RM388; normal RM688", sendOnPriceQuery: true, pricing: {offer:388,normal:688,currency:"MYR"}, imageUrl: "/promo-images/999"},
    ],
    guardrails: ["Never guarantee clinical outcomes or weight loss."],
    automatedFollowUp: {assessmentFirstPricingEnabled: true},
  };
}

test("scoped Pulse Wave benefits reach WhatsApp, Messenger and Instagram prompts in all customer languages", async () => {
  await withConfig(fixture(), () => {
    for (const channel of ["whatsapp", "facebook", "instagram"]) {
      for (const language of ["zh", "en", "ms"]) {
        const prompt = buildSystemPrompt({
          channel, replyLanguage: language,
          conversationContext: {
            currentCustomerText: "我想了解脉冲波调理",
            relevantServiceNames: ["脉冲波调理"],
            serviceSource: "current_customer",
          },
        });
        for (const fact of ["局部线条管理", "产后身体及骨盆护理", "肌肉紧绷僵硬", "经络养生", "水肿困扰"])
          assert.ok(prompt.includes(fact), `Missing ${fact} from ${channel}/${language}`);
        assert.match(prompt, /Do not claim 15cm tissue penetration/u);
        assert.doesNotMatch(prompt, /Manual pelvic care only/u);
        assert.match(prompt, /ACTIVE PROMOTIONS/u);
        assert.match(prompt, /priceQuery/u);
      }
    }
  });
});

test("compact discovery retains core benefits when the selected treatment is not yet confirmed", async () => {
  await withConfig(fixture(), () => {
    const prompt = buildSystemPrompt({
      conversationContext: {currentCustomerText:"想了解身体护理",relevantServiceNames:[],serviceSource:null},
    });
    for (const fact of ["局部线条管理", "产后身体及骨盆护理", "经络养生", "水肿困扰"])
      assert.ok(prompt.includes(fact), `Discovery context lost ${fact}`);
    assert.match(prompt, /No single current service is established/u);
  });
});

test("Pulse follow-up gets service knowledge but no automatic quotation permission", async () => {
  await withConfig(fixture(), () => {
    const prompt = buildFollowUpPrompt({channel:"whatsapp",followUpContext:{stepNumber:1,treatmentInterest:"脉冲波调理"}});
    assert.match(prompt, /局部线条管理/u);
    assert.match(prompt, /肌肉紧绷僵硬疲劳/u);
    assert.match(prompt, /Do not claim 15cm tissue penetration/u);
    assert.match(prompt, /NEVER write a treatment, original, package, discounted or first-trial price/u);
  });
});

test("general benefits enquiry cannot trigger a price promotion image", async () => {
  await withConfig(fixture(), async () => {
    const selected = await resolvePricePromotionForReply({
      treatment:"脉冲波调理",
      customerText:"脉冲波适合哪些身体部位？",
      conversationHistory:[{role:"user",content:"脉冲波适合哪些身体部位？"}],
      priceQuery:false,packageQuery:false,aiPricingEnabled:false,
      services:config.services,serviceAliases:config.serviceAliases,
      promotions:config.promotions,
      textSendSucceeded:true,flagged:false,bookingReady:false,needsAttention:false,
      wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(selected,null);
  });
});

test("service knowledge does not leak into unrelated clinics", async () => {
  await withConfig({...fixture(),services:[{name:"Different care",description:"Other facts",duration:"TBD"}],serviceAliases:[],promotions:[],sop:"Other SOP"}, () => {
    const prompt=buildSystemPrompt({conversationContext:{currentCustomerText:"Different care",relevantServiceNames:["Different care"]}});
    assert.doesNotMatch(prompt,/脉冲波调理|局部线条管理|15cm tissue penetration/u);
  });
});


test("replacement Pulse Wave poster is present and its source keeps verified promo terms", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const jpg = fs.readFileSync(path.join(__dirname, "../portal-frontend/public/neutro-pulse-safe-20261123.jpg"));
  assert.ok(jpg.length > 20_000, "reviewed promo artwork should be a substantial image");
  assert.equal(jpg.subarray(0, 3).toString("hex"), "ffd8ff", "must be a JPEG safe for WhatsApp media");
  const builder = fs.readFileSync(path.join(__dirname, "../scripts/buildNeutroPulsePromoPoster.py"), "utf8");
  for (const term of ["RM388", "RM688", "艾灸桶护理", "2 小时 15 分钟", "实际体验因人而异"])
    assert.ok(builder.includes(term), `missing commercial or safety wording: ${term}`);
  for (const forbidden of ["15cm", "深入骨髓", "偏头痛", "排湿寒气", "骨盆闭合", "瘦身减肥"])
    assert.ok(!builder.includes(forbidden), `unsupported graphic claim: ${forbidden}`);
});
