"use strict";

// Regression tests for clinic-configured first-session effectiveness guidance.
// The wording below is synthetic test data, not production chatbot copy.
// No prompt text is hardcoded into src/; only verified clinic_config supplies it.
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { buildSystemPrompt, buildFollowUpPrompt } =
  require("../src/utils/systemPrompt");
const { buildConversationPromptContext } =
  require("../src/utils/conversationPromptContext");
const { verifiedResultExampleForConversation } =
  require("../src/utils/verifiedResultMediaExample");

const serviceNames = [
  "1对1体态评估",
  "徒手体态调理",
  "3D 小颜术",
  "9D 逆龄抗衰",
  "3D + 9D 组合",
  "骨盆调理",
  "脉冲波调理",
  "产后调理",
  "子宫调理",
  "艾灸",
  "草药胸部疏通乳腺护理",
];

function withTestClinic(run) {
  const keys = [
    "businessName", "clinicName", "businessType", "sop",
    "messagingStyle", "faqs", "services", "guardrails", "resultMedia",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, config[key]]));
  try {
    config.businessName = "Neutro Sense TCM Centre";
    config.clinicName = config.businessName;
    config.businessType = "tcm_clinic";
    config.services = serviceNames.map((name) => ({
      name, description: "This service requires an individual assessment.",
      priceRange: "", duration: "",
    }));
    config.sop = [
      "FIRST-SESSION EFFECTIVENESS - CONFIGURED EXAMPLE",
      "For a plain one-session question, respond to the possibility of change first.",
      "骨盆调理: DEMO_PELVIC_REPLY_FROM_CONFIG",
      "3D 小颜术: DEMO_FACIAL_REPLY_FROM_CONFIG",
      "9D 逆龄抗衰: DEMO_9D_REPLY_FROM_CONFIG",
      "脉冲波调理: DEMO_PULSE_REPLY_FROM_CONFIG",
      "Breast symptoms: assess medically; no disease-treatment promises.",
      "Before & After requires independently verified one-session metadata.",
    ].join("\n");
    config.messagingStyle = [
      "FIRST-SESSION EFFECTIVENESS - CONFIGURED STYLE",
      "DEMO_POSITIVE_FIRST_FROM_CONFIG, not a guarantee.",
      "For an actual guarantee question, explain that results are not guaranteed.",
      "Match Chinese, English or Malay to the customer's message.",
    ].join("\n");
    config.faqs = [{
      q: "做一次就会看到明显效果吗？",
      a: "DEMO_FAQ_FROM_CONFIG: possibility first, individual outcomes vary.",
    }];
    config.guardrails = [
      "Never guarantee a first-session result, medical correction, or quantified change.",
      "Medical red flags and safety concerns require appropriate review.",
      "Do not invent prices, appointments, or marketing eligibility.",
    ];
    config.resultMedia = [{
      service: "3D 小颜术", enabled: true, items: [{
        imageUrl: "/api/config/result-media/image/12345",
        caption: "Example ad says one session (not verified).",
      }],
    }];
    return run();
  } finally {
    Object.assign(config, saved);
  }
}

test("all 11 services receive editable first-session guidance on WhatsApp, Facebook, and Instagram", () => {
  withTestClinic(() => {
    for (const channel of ["whatsapp", "facebook", "instagram"]) {
      for (const service of serviceNames) {
        const prompt = buildSystemPrompt({
          channel,
          conversationContext: {
            currentCustomerText: "一次见效吗？",
            relevantServiceNames: [service],
            promotionIntent: false,
          },
        });
        assert.match(prompt, /FIRST-SESSION EFFECTIVENESS - CONFIGURED EXAMPLE/u);
        assert.match(prompt, /DEMO_POSITIVE_FIRST_FROM_CONFIG/u);
        assert.match(prompt, /DEMO_FAQ_FROM_CONFIG/u);
        assert.match(prompt, /Never guarantee a first-session result/u);
        assert.match(prompt, /independently verified one-session metadata/u);
        assert.match(prompt, /ACTIVE PROMOTIONS/u);
      }
    }
  });
});

test("the regular Gemini prompt and follow-up use configured guidance, not hardcoded clinic script", () => {
  withTestClinic(() => {
    const { buildGeminiRequest } = require("../src/services/geminiService");
    const request = buildGeminiRequest(
      [{ role: "user", content: "3D 小颜术 一次有效吗？" }],
      { surface: "conversation", channel: "whatsapp" },
      "gemini-3.5-flash-lite"
    );
    assert.match(request.request.config.systemInstruction, /DEMO_FACIAL_REPLY_FROM_CONFIG/u);
    assert.match(request.request.config.systemInstruction, /DEMO_POSITIVE_FIRST_FROM_CONFIG/u);

    const followUp = buildFollowUpPrompt({
      followUpContext: { stepNumber: 3, treatmentInterest: "骨盆调理" },
    });
    assert.match(followUp, /DEMO_POSITIVE_FIRST_FROM_CONFIG/u);
    assert.match(followUp, /DEMO_PELVIC_REPLY_FROM_CONFIG/u);
  });
});

test("effectiveness is not treated as a monetary enquiry, while explicit price remains one", () => {
  withTestClinic(() => {
    for (const question of [
      "骨盆调理 一次见效吗？",
      "3D 小颜术 有效？",
      "9D 逆龄抗衰 第一次有分别吗？",
      "脉冲波调理 one session effective?",
      "Rawatan ini berkesan selepas satu sesi?",
    ]) {
      const context = buildConversationPromptContext([{ role: "user", content: question }]);
      assert.equal(context.promotionIntent, false, question);
    }
    const priceContext = buildConversationPromptContext([
      { role: "user", content: "3D 小颜术 做一次多少钱？" },
    ]);
    assert.equal(priceContext.promotionIntent, true);
  });
});

test("one-session claims from unverified media captions never establish verified result evidence", () => {
  withTestClinic(() => {
    const result = verifiedResultExampleForConversation({
      messages: [
        {
          role: "assistant",
          content: "Example ad says one session (not verified).",
          verifiedOutboundImageUrl: "/api/config/result-media/image/12345",
        },
        { role: "user", content: "一次就有效吗？" },
      ],
      resultMedia: config.resultMedia,
      serviceName: "3D 小颜术",
      customerText: "一次就有效吗？",
    });
    assert.equal(result, null);
  });
});

test("another clinic does not inherit Neutro-specific response examples", () => {
  withTestClinic(() => {
    config.businessName = "Independent Care";
    config.clinicName = "Independent Care";
    config.sop = "Independent care SOP";
    config.messagingStyle = "Independent care style";
    config.faqs = [];
    const prompt = buildSystemPrompt({ channel: "whatsapp" });
    assert.doesNotMatch(prompt, /DEMO_(?:POSITIVE|FACIAL|PELVIC|9D|PULSE|FAQ)/u);
    assert.doesNotMatch(prompt, /FIRST-SESSION EFFECTIVENESS - CONFIGURED/u);
  });
});
