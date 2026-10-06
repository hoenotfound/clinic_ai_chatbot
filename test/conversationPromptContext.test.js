const test = require("node:test");
const assert = require("node:assert/strict");

const config = require("../src/config/clinicConfig");
const {
  buildConversationPromptContext,
} = require("../src/utils/conversationPromptContext");
const {
  buildSystemPrompt,
} = require("../src/utils/systemPrompt");
const geminiService = require("../src/services/geminiService");

function withConfig(overrides, callback) {
  const previous = JSON.parse(JSON.stringify(config));
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, previous, overrides);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, previous);
  }
}

function scopedConfig() {
  return {
    businessName: "Context Clinic",
    clinicName: "Context Clinic",
    businessType: "tcm_clinic",
    businessDescription: "A TCM clinic in Malaysia.",
    aiAssistantName: "Clinic Assistant",
    terminology: {
      customerSingular: "patient",
      customerPlural: "patients",
      locationSingular: "clinic branch",
      locationPlural: "clinic branches",
      serviceSingular: "treatment",
      servicePlural: "treatments",
    },
    services: [
      {
        name: "3D 小颜术",
        description: "THREED_FULL_DETAILS face shape and contour.",
        priceRange: "THREED_PRICE RM488",
        duration: "90 minutes",
      },
      {
        name: "9D 逆龄抗衰",
        description: "NINED_FULL_DETAILS laxity and ageing concerns.",
        priceRange: "NINED_PRICE RM588",
        duration: "90 minutes",
      },
      {
        name: "骨盆调理",
        description: "PELVIS_FULL_DETAILS posture and pelvic care.",
        priceRange: "PELVIS_PRICE RM388",
        duration: "60 minutes",
      },
    ],
    serviceAliases: [
      { alias: "3D / 小颜 / 大小脸", officialService: "3D 小颜术" },
      { alias: "9D / 逆龄", officialService: "9D 逆龄抗衰" },
      { alias: "pelvis / 骨盆", officialService: "骨盆调理" },
    ],
    promotions: [
      {
        name: "3D Promo",
        linkedService: "3D 小颜术",
        caption: "THREED_PROMO_FULL",
        sendOnPriceQuery: true,
        packages: [
          { name: "Package A", caption: "THREED_PACKAGE_FULL" },
        ],
      },
      {
        name: "9D Promo",
        linkedService: "9D 逆龄抗衰",
        caption: "NINED_PROMO_FULL",
        sendOnPriceQuery: true,
      },
      {
        name: "Pelvis Promo",
        linkedService: "骨盆调理",
        caption: "PELVIS_PROMO_FULL",
        sendOnPriceQuery: true,
      },
    ],
    branches: [
      {
        name: "PJ",
        address: "PJ_ADDRESS_SENTINEL",
        phone: "PJ_PHONE_SENTINEL",
      },
      {
        name: "KL",
        address: "KL_ADDRESS_SENTINEL",
        phone: "KL_PHONE_SENTINEL",
      },
    ],
    hours: {
      general: "HOURS_SENTINEL 10am to 7pm",
      closed: "Monday closed",
    },
    contact: {
      whatsapp: "WHATSAPP_SENTINEL",
      instagram: "INSTAGRAM_SENTINEL",
      facebook: "FACEBOOK_SENTINEL",
    },
    faqs: [
      {
        q: "FAQ_QUESTION_SENTINEL",
        a: "FAQ_ANSWER_SENTINEL",
      },
    ],
    sop: [
      "GLOBAL SAFETY:",
      "GLOBAL_SAFETY_SENTINEL never diagnose.",
      "",
      "3D 小颜术:",
      "THREED_SOP_SENTINEL use face-shape wording.",
      "",
      "9D 逆龄抗衰:",
      "NINED_SOP_SENTINEL use laxity wording.",
      "",
      "骨盆调理:",
      "PELVIS_SOP_SENTINEL use posture wording.",
    ].join("\n"),
    closingPlaybook: [
      "GENERAL SALES:",
      "GLOBAL_SALES_SENTINEL keep one soft CTA.",
      "",
      "3D 小颜术:",
      "THREED_CLOSE_SENTINEL.",
      "",
      "骨盆调理:",
      "PELVIS_CLOSE_SENTINEL.",
    ].join("\n"),
    escalation: {
      outOfScopeTriggers: ["HANDOFF_SENTINEL medical suitability"],
      handoffMessage: "A team member will help directly.",
    },
    guardrails: [
      "GUARDRAIL_SENTINEL never invent treatment results.",
    ],
    tone: "Warm and concise.",
    messagingStyle: "STYLE_SENTINEL keep replies short and natural.",
  };
}

test("current customer treatment overrides older treatment context", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "之前我有问骨盆调理" },
      { role: "assistant", content: "可以" },
      { role: "user", content: "现在我想了解3D小颜" },
    ]);

    assert.deepEqual(context.relevantServiceNames, ["3D 小颜术"]);
    assert.equal(context.serviceSource, "current_customer");
  });
});

test("short price question inherits the most recent established treatment", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "想了解骨盆调理" },
      { role: "assistant", content: "可以，主要想改善哪方面？" },
      { role: "user", content: "多少钱？" },
    ]);

    assert.deepEqual(context.relevantServiceNames, ["骨盆调理"]);
    assert.equal(context.serviceSource, "recent_customer");
    assert.equal(context.promotionIntent, true);
  });
});

test("real Neutro price phrasing restores promotion context", () => {
  withConfig(scopedConfig(), () => {
    for (const phrase of ["How much", "费用多少", "一次疗程是几多", "这288是吗"]) {
      const context = buildConversationPromptContext([
        { role: "user", content: "你好！我想了解你们骨盆的疗程" },
        { role: "assistant", content: "骨盆调理可以先做1对1评估。" },
        { role: "user", content: phrase },
      ]);

      assert.deepEqual(context.relevantServiceNames, ["骨盆调理"], phrase);
      assert.equal(context.promotionIntent, true, phrase);
    }
  });
});

test("real Neutro location phrasing restores full branch details", () => {
  withConfig(scopedConfig(), () => {
    for (const phrase of ["店在哪里", "你们的店在哪儿？", "Where is the place"]) {
      const context = buildConversationPromptContext([
        { role: "user", content: "你好！我想了解你们骨盆的疗程" },
        { role: "assistant", content: "可以呀～" },
        { role: "user", content: phrase },
      ]);
      assert.equal(context.schedulingIntent, true, phrase);

      const prompt = buildSystemPrompt({
        channel: "whatsapp",
        conversationContext: context,
      });
      assert.match(prompt, /PJ_ADDRESS_SENTINEL/, phrase);
    }
  });
});

test("recent assistant can anchor an unambiguous service after an ambiguous customer topic shift", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    services: [
      ...base.services,
      {
        name: "徒手体态调理",
        description: "MANUAL_POSTURE_DETAILS",
        priceRange: "",
        duration: "",
      },
    ],
    serviceAliases: [
      ...base.serviceAliases,
      { alias: "徒手调理", officialService: "徒手体态调理" },
    ],
  }, () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "你好！我想了解你们骨盆的疗程" },
      { role: "assistant", content: "骨盆调理主要看骨盆和整体体态。" },
      { role: "user", content: "你看见你的宣传有调整身体" },
      { role: "assistant", content: "有的呀～我们的徒手体态调理主要是用手法看整体平衡，像骨盆、腰背、肩颈这些都会根据个人情况来看。" },
      { role: "user", content: "颈不舒服咯" },
    ]);

    assert.deepEqual(context.relevantServiceNames, ["徒手体态调理"]);
    assert.equal(context.serviceSource, "recent_assistant");
  });
});

test("service anchor survives staff and result-media chatter within the AI history window", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    services: [
      ...base.services,
      {
        name: "徒手体态调理",
        description: "MANUAL_POSTURE_DETAILS",
        priceRange: "",
        duration: "",
      },
    ],
    serviceAliases: [
      ...base.serviceAliases,
      { alias: "徒手调理", officialService: "徒手体态调理" },
    ],
  }, () => {
    const messages = [
      { role: "user", content: "你好！我想了解你们骨盆的疗程" },
      { role: "assistant", content: "骨盆调理主要看骨盆和整体体态。" },
      { role: "user", content: "你看见你的宣传有调整身体" },
      { role: "assistant", content: "有的呀～我们的徒手体态调理主要是用手法看整体平衡，像骨盆、腰背、肩颈这些都会根据个人情况来看。" },
      { role: "user", content: "颈不舒服咯" },
      { role: "assistant", content: "可以先看看肩颈紧绷情况。" },
      { role: "user", content: "腰酸背痛就没有" },
      { role: "assistant", content: "了解～主要是肩颈这边。" },
      { role: "assistant", content: "想跟进一下，有问题可以问我。" },
      { role: "assistant", content: "这个是顾客护理后的 Before & After。" },
      { role: "assistant", content: "想了解的话可以再告诉我。" },
      { role: "user", content: "通常一次可以维持多久" },
    ];

    const context = buildConversationPromptContext(messages);
    assert.deepEqual(context.relevantServiceNames, ["徒手体态调理"]);
    assert.equal(context.serviceSource, "recent_assistant");
  });
});

test("assessment wording never replaces the actual treatment anchor", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    services: [
      {
        name: "1对1体态评估",
        description: "ASSESSMENT_DETAILS",
        priceRange: "",
        duration: "",
      },
      ...base.services,
    ],
    serviceAliases: [
      { alias: "体态评估", officialService: "1对1体态评估" },
      ...base.serviceAliases,
    ],
  }, () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "你好！我想了解你们骨盆的疗程" },
      { role: "assistant", content: "可以呀～" },
      { role: "user", content: "评估需要多久？" },
      { role: "assistant", content: "整个1对1体态评估+体验大约需要1小时左右。" },
      { role: "user", content: "也想了解一下价钱" },
    ]);

    assert.deepEqual(context.relevantServiceNames, ["骨盆调理"]);
    assert.equal(context.serviceSource, "recent_customer");
    assert.equal(context.promotionIntent, true);
  });
});

test("assistant suggestion cannot override a service explicitly chosen by the customer", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "9D是针对什么的呢" },
      { role: "assistant", content: "如果主要看脸型轮廓，也可以另外了解3D小颜术。" },
      { role: "user", content: "多少钱" },
    ]);

    assert.deepEqual(context.relevantServiceNames, ["9D 逆龄抗衰"]);
    assert.equal(context.serviceSource, "recent_customer");
  });
});

test("compact alphanumeric service codes are inferred from a unique configured service name", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    services: [
      base.services[0],
      base.services[1],
      {
        name: "3D + 9D 组合",
        description: "COMBO_DETAILS",
        priceRange: "",
        duration: "",
      },
    ],
    serviceAliases: [
      { alias: "小颜术", officialService: "3D 小颜术" },
      { alias: "9D逆龄", officialService: "9D 逆龄抗衰" },
      { alias: "3D+9D", officialService: "3D + 9D 组合" },
    ],
  }, () => {
    const single = buildConversationPromptContext([
      { role: "user", content: "price for 3D xiao yan shu?" },
    ]);
    assert.deepEqual(single.relevantServiceNames, ["3D 小颜术"]);

    const comparison = buildConversationPromptContext([
      { role: "user", content: "3D跟9D有什么不同？" },
    ]);
    assert.deepEqual(
      comparison.relevantServiceNames,
      ["3D 小颜术", "9D 逆龄抗衰"]
    );
    assert.doesNotMatch(
      comparison.relevantServiceNames.join("|"),
      /3D \+ 9D 组合/
    );
  });
});

test("two-service comparison preserves exactly the two services in the current message", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "之前问过骨盆" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "3D跟9D有什么不同？" },
    ]);

    assert.deepEqual(
      context.relevantServiceNames,
      ["3D 小颜术", "9D 逆龄抗衰"]
    );
  });
});

test("explicit request for other treatments does not inherit the previous single treatment", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "想了解骨盆调理" },
      { role: "assistant", content: "可以～" },
      { role: "user", content: "还有什么其他疗程？" },
    ]);

    assert.deepEqual(context.relevantServiceNames, []);
    assert.equal(context.serviceSource, "broad_discovery");
    assert.equal(context.serviceDiscoveryIntent, true);

    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: context,
    });
    assert.match(prompt, /THREED_FULL_DETAILS/);
    assert.match(prompt, /NINED_FULL_DETAILS/);
    assert.match(prompt, /PELVIS_FULL_DETAILS/);
    assert.doesNotMatch(prompt, /THREED_PRICE/);
    assert.doesNotMatch(prompt, /NINED_PRICE/);
    assert.doesNotMatch(prompt, /PELVIS_PRICE/);
  });
});

test("broad treatment price request restores configured prices instead of using the compact catalog", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "可以给我全部疗程的price吗？" },
    ]);

    assert.deepEqual(context.relevantServiceNames, []);
    assert.equal(context.promotionIntent, true);

    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: context,
    });
    assert.match(prompt, /THREED_PRICE/);
    assert.match(prompt, /NINED_PRICE/);
    assert.match(prompt, /PELVIS_PRICE/);
  });
});

test("broad discovery overrides a treatment name when customer asks for other treatments", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "Besides 3D, what other treatments do you have?" },
    ]);

    assert.deepEqual(context.relevantServiceNames, []);
    assert.equal(context.serviceSource, "broad_discovery");

    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: context,
    });
    assert.match(prompt, /THREED_FULL_DETAILS/);
    assert.match(prompt, /NINED_FULL_DETAILS/);
    assert.match(prompt, /PELVIS_FULL_DETAILS/);
  });
});

test("three-service customer comparison falls back to the broad compact catalog instead of dropping a service", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "3D、9D和骨盆调理有什么不同？" },
    ], {
      metaAdContext: {
        headline: "3D 小颜术",
        body: "脸型轮廓",
      },
    });

    assert.deepEqual(context.relevantServiceNames, []);
    assert.equal(context.serviceSource, "multi_service_broad");

    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: context,
    });
    assert.match(prompt, /THREED_FULL_DETAILS/);
    assert.match(prompt, /NINED_FULL_DETAILS/);
    assert.match(prompt, /PELVIS_FULL_DETAILS/);
    assert.doesNotMatch(prompt, /THREED_PRICE/);
    assert.doesNotMatch(prompt, /NINED_PRICE/);
    assert.doesNotMatch(prompt, /PELVIS_PRICE/);
  });
});

test("photo caption still drives normal reply treatment context without removing the image", () => {
  withConfig(scopedConfig(), () => {
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: "想问这个骨盆调理多少钱？" },
        { type: "image", mimeType: "image/jpeg", data: "abc123" },
      ],
    }];

    const context = buildConversationPromptContext(messages);
    assert.deepEqual(context.relevantServiceNames, ["骨盆调理"]);
    assert.equal(context.promotionIntent, true);

    const built = geminiService.buildGeminiRequest(
      messages,
      { channel: "whatsapp", surface: "conversation" },
      "gemini-3.8-flash"
    );
    assert.equal(built.request.contents.length, 1);
    assert.equal(built.request.contents[0].parts.length, 2);
    assert.equal(built.request.contents[0].parts[0].text, "想问这个骨盆调理多少钱？");
    assert.equal(built.request.contents[0].parts[1].inlineData.data, "abc123");
    assert.match(built.request.config.systemInstruction, /PELVIS_FULL_DETAILS/);
  });
});

test("vague lead can use one unambiguous Meta creative service without changing conversation text", () => {
  withConfig(scopedConfig(), () => {
    const messages = [{ role: "user", content: "想了解" }];
    const context = buildConversationPromptContext(messages, {
      metaAdContext: {
        headline: "产后骨盆调理",
        body: "1对1体态评估",
      },
    });

    assert.deepEqual(context.relevantServiceNames, ["骨盆调理"]);
    assert.equal(context.serviceSource, "meta_ad");
    assert.deepEqual(messages, [{ role: "user", content: "想了解" }]);
  });
});

test("scoped normal prompt keeps relevant treatment detail and global safety while dropping unrelated treatment detail", () => {
  withConfig(scopedConfig(), () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      isFirstMessage: false,
      conversationContext: {
        relevantServiceNames: ["3D 小颜术"],
        serviceSource: "current_customer",
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: false,
      },
    });

    assert.match(prompt, /THREED_FULL_DETAILS/);
    assert.match(prompt, /THREED_PRICE/);
    assert.doesNotMatch(prompt, /NINED_FULL_DETAILS/);
    assert.doesNotMatch(prompt, /PELVIS_FULL_DETAILS/);

    assert.match(prompt, /3D Promo/);
    assert.doesNotMatch(prompt, /THREED_PROMO_FULL/);
    assert.doesNotMatch(prompt, /THREED_PACKAGE_FULL/);
    assert.doesNotMatch(prompt, /NINED_PROMO_FULL/);
    assert.doesNotMatch(prompt, /PELVIS_PROMO_FULL/);

    assert.match(prompt, /GLOBAL_SAFETY_SENTINEL/);
    assert.match(prompt, /THREED_SOP_SENTINEL/);
    assert.doesNotMatch(prompt, /NINED_SOP_SENTINEL/);
    assert.doesNotMatch(prompt, /PELVIS_SOP_SENTINEL/);

    assert.match(prompt, /GLOBAL_SALES_SENTINEL/);
    assert.match(prompt, /THREED_CLOSE_SENTINEL/);
    assert.doesNotMatch(prompt, /PELVIS_CLOSE_SENTINEL/);

    assert.match(prompt, /FAQ_ANSWER_SENTINEL/);
    assert.match(prompt, /GUARDRAIL_SENTINEL/);
    assert.match(prompt, /HANDOFF_SENTINEL/);
    assert.match(prompt, /STYLE_SENTINEL/);

    assert.match(prompt, /- PJ/);
    assert.match(prompt, /- KL/);
    assert.doesNotMatch(prompt, /PJ_ADDRESS_SENTINEL/);
    assert.doesNotMatch(prompt, /KL_ADDRESS_SENTINEL/);
    assert.doesNotMatch(prompt, /HOURS_SENTINEL/);
    assert.doesNotMatch(prompt, /WHATSAPP_SENTINEL/);
    assert.doesNotMatch(prompt, /INSTAGRAM_SENTINEL/);
  });
});

test("relevant service promotion enquiry restores full matching promotion/package detail", () => {
  withConfig(scopedConfig(), () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["3D 小颜术"],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /THREED_PACKAGE_FULL/);
    assert.doesNotMatch(prompt, /NINED_PROMO_FULL/);
    assert.doesNotMatch(prompt, /PELVIS_PROMO_FULL/);
  });
});

test("long promo ad copy is compacted while all commercial terms remain available to the AI", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    promotions: [{
      name: "3D 小颜术 First Trial",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: true,
      packages: [],
      validFrom: "2026-10-01",
      validUntil: "2026-10-31",
      caption: `LONG_AD_CLAIM bone-gap claim and other marketing copy. ${"LONG_AD_FILLER ".repeat(80)}`,
      followUpMessage: [
        "RM 488",
        "(Normal RM 1288)",
        "2 hours 30 minutes",
        "Includes 3D 小颜术",
        "Free 全身通淋巴按摩 - 1 hour",
        "脸部提升刮痧 / V脸 / 五官塑造按摩 / V-shape mask",
      ].join("\n"),
    }],
  }, () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["3D 小颜术"],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /3D 小颜术 First Trial/);
    assert.match(prompt, /RM 488/);
    assert.match(prompt, /Normal RM 1288/);
    assert.match(prompt, /2 hours 30 minutes/);
    assert.match(prompt, /全身通淋巴按摩/);
    assert.match(prompt, /V-shape mask/);
    assert.match(prompt, /2026-10-01/);
    assert.match(prompt, /2026-10-31/);
    assert.doesNotMatch(prompt, /LONG_AD_CLAIM/);
    assert.doesNotMatch(prompt, /LONG_AD_FILLER/);
    assert.match(prompt, /exact long-form promotional caption is handled by the promotion media system/);
  });
});

test("promo caption remains available when it is the only configured source of offer facts", () => {
  const base = scopedConfig();
  const uniqueTail = "UNIQUE_OFFER_FACT_AT_END";
  withConfig({
    ...base,
    promotions: [{
      name: "3D Caption Only Promo",
      linkedService: "3D 小颜术",
      sendOnPriceQuery: true,
      packages: [],
      validFrom: "2026-10-01",
      validUntil: "2026-10-31",
      caption: `${"Configured offer detail ".repeat(80)}${uniqueTail}`,
      followUpMessage: "",
    }],
  }, () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["3D 小颜术"],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /3D Caption Only Promo/);
    assert.match(prompt, /UNIQUE_OFFER_FACT_AT_END/);
  });
});

test("short combo caption and follow-up gift are both preserved as promo knowledge", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    services: [
      ...base.services,
      {
        name: "3D + 9D 组合",
        description: "Combination service",
        priceRange: "Current promotional price comes from active promotions",
        duration: "",
      },
    ],
    promotions: [{
      name: "9D + 3D 组合限时优惠",
      linkedService: "3D + 9D 组合",
      sendOnPriceQuery: true,
      packages: [],
      validFrom: "2026-10-01",
      validUntil: "2026-10-31",
      caption: "9D + 3D 组合限时优惠: RM688",
      followUpMessage: "Includes 经络按摩",
    }],
  }, () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["3D + 9D 组合"],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /RM688/);
    assert.match(prompt, /Includes 经络按摩/);
  });
});

test("package promo knowledge preserves A/B prices, aliases, voucher and inclusions", () => {
  const base = scopedConfig();
  withConfig({
    ...base,
    promotions: [{
      name: "骨盆调理套餐",
      linkedService: "骨盆调理",
      sendOnPriceQuery: true,
      packages: [
        {
          name: "Package A",
          title: "尊享护理配套｜2小时30分钟",
          aliases: ["A套餐", "RM488配套", "488配套"],
          caption: [
            "RM100 优惠券限时领取",
            "原价优惠 RM488",
            "优惠后仅需 RM388",
            "包含：骨盆护理｜腹直肌・盆底肌护理",
            "经络穴位按摩",
            "子宫草药护理",
            "AI 身体检测",
          ].join("\n"),
          followUpMessage: "RM100 优惠券限时领取（只限100位）",
        },
        {
          name: "Package B",
          title: "1小时30分钟女性护理配套",
          aliases: ["B套餐", "RM288配套", "288配套", "女性护理配套"],
          caption: [
            "RM100 OFF",
            "原价 RM388",
            "现在只需 RM288",
            "包含：骨盆护理｜腹直肌・盆底肌",
            "子宫护理",
            "艾灸桶护理",
          ].join("\n"),
          followUpMessage: "本月限时优惠 RM100 OFF",
        },
      ],
    }],
  }, () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["骨盆调理"],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /Package A/);
    assert.match(prompt, /A套餐/);
    assert.match(prompt, /RM488配套/);
    assert.match(prompt, /RM388/);
    assert.match(prompt, /RM100 优惠券/);
    assert.match(prompt, /经络穴位按摩/);
    assert.match(prompt, /子宫草药护理/);
    assert.match(prompt, /AI 身体检测/);

    assert.match(prompt, /Package B/);
    assert.match(prompt, /B套餐/);
    assert.match(prompt, /RM288配套/);
    assert.match(prompt, /RM288/);
    assert.match(prompt, /子宫护理/);
    assert.match(prompt, /艾灸桶护理/);
  });
});

test("day and time reply restores scheduling details even without booking keywords", () => {
  withConfig(scopedConfig(), () => {
    const context = buildConversationPromptContext([
      { role: "user", content: "骨盆调理" },
      { role: "assistant", content: "Which day and time works for you?" },
      { role: "user", content: "Saturday 3pm" },
    ]);

    assert.equal(context.schedulingIntent, true);

    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: context,
    });
    assert.match(prompt, /HOURS_SENTINEL/);
    assert.match(prompt, /PJ_ADDRESS_SENTINEL/);
  });
});

test("booking or location conversation restores branch addresses and hours", () => {
  withConfig(scopedConfig(), () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: ["骨盆调理"],
        schedulingIntent: true,
        contactIntent: false,
        promotionIntent: false,
      },
    });

    assert.match(prompt, /PJ_ADDRESS_SENTINEL/);
    assert.match(prompt, /KL_ADDRESS_SENTINEL/);
    assert.match(prompt, /HOURS_SENTINEL/);
  });
});

test("generic discovery keeps compact service catalog instead of full prices and unrelated promotion copy", () => {
  withConfig(scopedConfig(), () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: [],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: false,
      },
    });

    assert.match(prompt, /THREED_FULL_DETAILS/);
    assert.match(prompt, /NINED_FULL_DETAILS/);
    assert.match(prompt, /PELVIS_FULL_DETAILS/);
    assert.doesNotMatch(prompt, /THREED_PRICE/);
    assert.doesNotMatch(prompt, /NINED_PRICE/);
    assert.doesNotMatch(prompt, /PELVIS_PRICE/);

    assert.match(prompt, /3D Promo/);
    assert.match(prompt, /9D Promo/);
    assert.match(prompt, /Pelvis Promo/);
    assert.doesNotMatch(prompt, /THREED_PROMO_FULL/);
    assert.doesNotMatch(prompt, /NINED_PROMO_FULL/);
    assert.doesNotMatch(prompt, /PELVIS_PROMO_FULL/);
  });
});

test("generic promotion enquiry restores full active promotion detail", () => {
  withConfig(scopedConfig(), () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: [],
        schedulingIntent: false,
        contactIntent: false,
        promotionIntent: true,
      },
    });

    assert.match(prompt, /THREED_PACKAGE_FULL/);
    assert.match(prompt, /NINED_PROMO_FULL/);
    assert.match(prompt, /PELVIS_PROMO_FULL/);
  });
});

test("Gemini request keeps full conversation while scoping repeated static context", () => {
  withConfig(scopedConfig(), () => {
    const messages = [
      { role: "user", content: "想了解骨盆调理" },
      { role: "assistant", content: "可以～你主要想改善哪方面？" },
      { role: "user", content: "产后小腹凸，多少钱？" },
    ];

    const built = geminiService.buildGeminiRequest(
      messages,
      { channel: "whatsapp", surface: "conversation" },
      "gemini-3.8-flash"
    );

    assert.equal(built.request.contents.length, messages.length);
    assert.equal(
      built.request.contents[0].parts[0].text,
      messages[0].content
    );
    assert.equal(
      built.request.contents[2].parts[0].text,
      messages[2].content
    );

    const prompt = built.request.config.systemInstruction;
    assert.match(prompt, /PELVIS_FULL_DETAILS/);
    assert.match(prompt, /PELVIS_PRICE/);
    assert.doesNotMatch(prompt, /THREED_FULL_DETAILS/);
    assert.doesNotMatch(prompt, /NINED_FULL_DETAILS/);
  });
});
