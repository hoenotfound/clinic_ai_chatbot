const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getLeadTemperatureRuleProfile,
} = require("../src/config/leadTemperatureRuleProfiles");
const {
  classifyTemperatureMessage,
  createLeadTemperatureReviewer,
} = require("../src/services/leadTemperatureAutomation");

const renovationProfile = getLeadTemperatureRuleProfile({
  businessType: "home_renovation",
});

function classifyRenovation(messageText, extra = {}) {
  return classifyTemperatureMessage({
    messageText,
    ruleProfile: renovationProfile,
    ...extra,
  });
}

test("lead temperature rule profiles preserve legacy clinic default and select renovation/generic explicitly", () => {
  assert.equal(getLeadTemperatureRuleProfile({}).mode, "appointment");
  assert.equal(
    getLeadTemperatureRuleProfile({ businessType: "aesthetic_clinic" }).mode,
    "appointment"
  );
  assert.equal(
    getLeadTemperatureRuleProfile({ businessType: "home_renovation" }).mode,
    "project"
  );
  assert.equal(getLeadTemperatureRuleProfile({ businessType: "generic" }).mode, "generic");
  assert.equal(getLeadTemperatureRuleProfile({ businessType: "future_unknown" }).mode, "generic");
});

test("clear renovation next-step intent becomes Hot in English, Bahasa Malaysia, and Chinese", () => {
  const examples = [
    "Can you prepare a quotation for my kitchen cabinets?",
    "Can you arrange a site visit?",
    "How do I pay the deposit?",
    "Let's proceed with the project.",
    "Can your team come and measure the site?",
    "Saya nak quotation untuk kitchen cabinet.",
    "Boleh arrange site visit?",
    "Macam mana nak bayar deposit?",
    "Saya nak teruskan project ini.",
    "Boleh datang ukur site saya?",
    "可以帮我出报价吗？",
    "可以安排上门量尺吗？",
    "怎么付定金？",
    "我想继续这个装修项目。",
  ];

  for (const messageText of examples) {
    const result = classifyRenovation(messageText);
    assert.equal(result?.temperature, "hot", messageText);
    assert.equal(result?.matchedRule, "project_commitment", messageText);
  }
});

test("renovation research, project details, budget, comparison, and uncertainty remain Warm", () => {
  const examples = [
    "How much per foot?",
    "Do you cover Kajang?",
    "Which material is better for kitchen cabinets?",
    "My budget is RM4500.",
    "I have a condo in Cheras and I can send the floor plan.",
    "Can I send you photos of my kitchen?",
    "How long does renovation normally take?",
    "Your quote is too expensive, I need to compare first.",
    "Maybe later, I am still comparing quotes.",
    "I don't want a site visit yet.",
    "Saturday doesn't work for me.",
    "Berapa harga per kaki?",
    "Budget saya RM4500.",
    "Saya masih banding quotation dulu.",
    "Mahal sangat, saya fikir dulu.",
    "这个报价太贵，我先比较一下。",
    "我的预算是RM4500。",
    "暂时不安排上门量尺。",
    "我还在考虑。",
    "",
  ];

  for (const messageText of examples) {
    assert.equal(classifyRenovation(messageText), null, messageText);
  }
});

test("renovation explicit rejection becomes Cold while definitive project endings are absolute", () => {
  const standardExamples = [
    "No thanks, I am not interested.",
    "I don't want to proceed with the renovation.",
    "We are not going ahead with this project.",
    "Saya tak berminat.",
    "Saya tak nak teruskan project ini.",
    "我不想继续装修。",
    "我不感兴趣，谢谢。",
  ];

  for (const messageText of standardExamples) {
    const result = classifyRenovation(messageText);
    assert.equal(result?.temperature, "cold", messageText);
    assert.equal(result?.matchedRule, "explicit_rejection", messageText);
    assert.equal(result?.rejectionStrength, "standard", messageText);
  }

  const absoluteExamples = [
    "The project is cancelled.",
    "We already hired another contractor.",
    "Projek dah batal.",
    "Kami sudah pilih kontraktor lain.",
    "装修不做了。",
    "已经找了别的装修公司。",
    "Please stop messaging me.",
    "Sorry, wrong number.",
  ];

  for (const messageText of absoluteExamples) {
    const result = classifyRenovation(messageText);
    assert.equal(result?.temperature, "cold", messageText);
    assert.equal(result?.rejectionStrength, "absolute", messageText);
  }
});

test("rejecting one renovation service does not incorrectly make the whole lead Cold", () => {
  const examples = [
    "I don't want kitchen cabinets.",
    "I don't want kitchen cabinets, but I am interested in wardrobes.",
    "Saya tak nak kitchen cabinet, tapi berminat dengan wardrobe.",
    "我不要厨房柜，但是想了解衣柜。",
  ];

  for (const messageText of examples) {
    assert.equal(classifyRenovation(messageText), null, messageText);
  }
});

test("renovation short next-step answers become Hot only in immediate relevant context", () => {
  const cases = [
    {
      previousBusinessMessage: "Would you like us to arrange a site visit or prepare a quotation?",
      messageText: "Quotation please",
    },
    {
      previousBusinessMessage: "Would you like us to arrange a site visit or prepare a quotation?",
      messageText: "Site visit please",
    },
    {
      previousBusinessMessage: "Which day would work for the site visit?",
      messageText: "Saturday afternoon",
    },
    {
      previousBusinessMessage: "Which day would work for the site visit?",
      messageText: "Saturday can't, but Sunday works for me.",
    },
    {
      previousBusinessMessage: "Nak kami arrange site visit atau sediakan quotation?",
      messageText: "Quotation boleh",
    },
    {
      previousBusinessMessage: "需要我们安排上门量尺还是先准备报价？",
      messageText: "先报价",
    },
  ];

  for (const input of cases) {
    const result = classifyRenovation(input.messageText, input);
    assert.equal(result?.temperature, "hot", input.messageText);
    assert.equal(result?.matchedRule, "project_next_step_confirmation", input.messageText);
  }

  for (const messageText of ["Quotation please", "Site visit please", "Saturday afternoon"]) {
    assert.equal(classifyRenovation(messageText), null, messageText);
  }
});

test("renovation property/location answers alone remain Warm even after ordinary qualification prompts", () => {
  const result = classifyRenovation("Cheras", {
    previousBusinessMessage: "Which area is the renovation project in?",
    locationNames: ["Puchong Showroom"],
  });
  assert.equal(result, null);
});

test("generic profile does not inherit clinic or renovation Hot vocabulary", () => {
  assert.equal(
    classifyTemperatureMessage({
      messageText: "Can I book an appointment tomorrow?",
      businessType: "generic",
    }),
    null
  );
  assert.equal(
    classifyTemperatureMessage({
      messageText: "Can you arrange a site visit and quotation?",
      businessType: "generic",
    }),
    null
  );

  const stop = classifyTemperatureMessage({
    messageText: "Please stop messaging me.",
    businessType: "generic",
  });
  assert.equal(stop?.temperature, "cold");
  assert.equal(stop?.rejectionStrength, "absolute");
});

test("renovation reviewer applies direct project intent without loading history", async () => {
  const applied = [];
  let historyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 31, temperature: "warm", is_closed: false }),
      applyRuleBasedTemperature: async (leadId, classification, currentTemperature) => {
        applied.push({ leadId, classification, currentTemperature });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => {
        historyCalls += 1;
        return [];
      },
    },
    getLocationNames: () => [],
    getRuleProfile: () => renovationProfile,
  });

  const result = await reviewer(90, 501, "Can you arrange a site visit?");
  assert.equal(result.status, "updated");
  assert.equal(result.lead.temperature, "hot");
  assert.equal(result.classification.matchedRule, "project_commitment");
  assert.equal(historyCalls, 0);
  assert.equal(applied[0].currentTemperature, "warm");
});

test("renovation reviewer uses current journey context for a short next-step confirmation", async () => {
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({
        id: 32,
        temperature: "warm",
        is_closed: false,
        started_message_id: 600,
      }),
      applyRuleBasedTemperature: async (leadId, classification) => {
        applied.push({ leadId, classification });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [
        {
          id: 600,
          role: "assistant",
          content: "Would you like us to arrange a site visit or prepare a quotation?",
        },
        { id: 601, role: "user", content: "Quotation please" },
      ],
    },
    getLocationNames: () => [],
    getRuleProfile: () => renovationProfile,
  });

  const result = await reviewer(91, 601, "Quotation please");
  assert.equal(result.status, "updated");
  assert.equal(applied[0].classification.matchedRule, "project_next_step_confirmation");
});

test("Hot renovation leads cool only for an absolute project-ending rejection", async () => {
  let activeLead = { id: 40, temperature: "hot", is_closed: false };
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => activeLead,
      applyRuleBasedTemperature: async (leadId, classification, currentTemperature) => {
        applied.push({ leadId, classification, currentTemperature });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: { getMessagesForContact: async () => [] },
    getLocationNames: () => [],
    getRuleProfile: () => renovationProfile,
  });

  const ordinaryDecline = await reviewer(92, 700, "No thanks, I am not interested.");
  assert.equal(ordinaryDecline.status, "unchanged");
  assert.equal(ordinaryDecline.reason, "transition-not-allowed");
  assert.equal(applied.length, 0);

  const cancelled = await reviewer(92, 701, "The project is cancelled.");
  assert.equal(cancelled.status, "updated");
  assert.equal(cancelled.lead.temperature, "cold");
  assert.equal(applied[0].classification.rejectionStrength, "absolute");
  assert.equal(applied[0].currentTemperature, "hot");
});
