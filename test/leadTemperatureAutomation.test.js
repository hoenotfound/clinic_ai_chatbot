const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyTemperatureMessage,
  createLeadTemperatureReviewer,
} = require("../src/services/leadTemperatureAutomation");

test("clear booking intent becomes Hot in English, Bahasa Malaysia, and Chinese", () => {
  const examples = [
    "Can I book an appointment this Saturday?",
    "Saya nak buat appointment di Puchong.",
    "我想预约星期六。",
    "Do you have any available slots tomorrow?",
    "I would like an appointment next week.",
    "Can I come this Saturday?",
    "Macam mana nak booking?",
    "Boleh saya datang hari Sabtu?",
    "还有空位吗？",
  ];

  for (const messageText of examples) {
    const result = classifyTemperatureMessage({ messageText });
    assert.equal(result?.temperature, "hot", messageText);
    assert.equal(result?.matchedRule, "booking_intent", messageText);
  }
});

test("explicit rejection becomes Cold in English, Bahasa Malaysia, and Chinese", () => {
  const examples = [
    "No thanks, I am not interested.",
    "Please stop messaging me.",
    "Sorry, wrong number.",
    "I don't want to book.",
    "I'm not going to book.",
    "Saya tak berminat.",
    "Saya tak nak book.",
    "Jangan hubungi saya lagi.",
    "谢谢不用了。",
    "不要再联系我。",
  ];

  for (const messageText of examples) {
    const result = classifyTemperatureMessage({ messageText });
    assert.equal(result?.temperature, "cold", messageText);
    assert.equal(result?.matchedRule, "explicit_rejection", messageText);
  }
});

test("general interest, uncertainty, cancellation, and silence remain Warm", () => {
  const examples = [
    "How much is HIFU?",
    "I am not sure yet.",
    "I can't come this Saturday, maybe another time.",
    "Do you have a branch in Puchong?",
    "Maybe I will think about it first.",
    "I want to visit your website first.",
    "I want to book, but I am not ready yet.",
    "I don't want to book yet.",
    "Maybe I want to book next week.",
    "Berapa harga treatment ini?",
    "Saya tak nak book dulu.",
    "Mungkin saya nak book minggu depan.",
    "这个疗程多少钱？",
    "暂时不预约。",
    "可能想预约下周。",
    "",
  ];

  for (const messageText of examples) {
    assert.equal(classifyTemperatureMessage({ messageText }), null, messageText);
  }
});

test("mixed treatment preferences do not incorrectly become Cold", () => {
  const examples = [
    "I am not interested in fillers.",
    "I don't want fillers.",
    "I am not interested in fillers, but I want to know more about HIFU.",
    "I am not interested in fillers, but how much is HIFU?",
    "Saya tak nak facial.",
    "Saya tak nak facial, tapi berminat dengan HIFU.",
    "Saya tak nak facial, tapi berapa harga HIFU?",
    "我对填充没兴趣。",
    "我对填充没兴趣，但是想了解HIFU。",
    "我对填充没兴趣，但是HIFU多少钱？",
  ];

  for (const messageText of examples) {
    assert.equal(classifyTemperatureMessage({ messageText }), null, messageText);
  }
});

test("a scheduling answer becomes Hot only after a clinic booking question", () => {
  const branchNames = ["Puchong", "KLCC"];
  const previousClinicMessage = "Which branch and appointment time would work for you?";

  for (const messageText of ["Saturday", "3 pm", "Puchong", "Yes please", "明天下午3点"]) {
    const result = classifyTemperatureMessage({
      messageText,
      previousClinicMessage,
      branchNames,
    });
    assert.equal(result?.temperature, "hot", messageText);
    assert.equal(result?.matchedRule, "scheduling_confirmation", messageText);
  }

  assert.equal(classifyTemperatureMessage({ messageText: "Saturday", branchNames }), null);
  assert.equal(classifyTemperatureMessage({
    messageText: "How much?",
    previousClinicMessage,
    branchNames,
  }), null);

  for (const messageText of [
    "I can't come this Saturday, maybe another time.",
    "Friday doesn't work for me.",
    "Saya tak boleh datang hari Sabtu.",
    "星期六不方便。",
  ]) {
    assert.equal(classifyTemperatureMessage({
      messageText,
      previousClinicMessage,
      branchNames,
    }), null, messageText);
  }
});

test("reviewer applies a direct rule without loading conversation history", async () => {
  const applied = [];
  let historyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 4, temperature: "warm", is_closed: false }),
      applyRuleBasedTemperature: async (leadId, classification) => {
        applied.push({ leadId, classification });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => {
        historyCalls += 1;
        return [];
      },
    },
    getBranchNames: () => ["Puchong"],
  });

  const result = await reviewer(12, 90, "I would like to book tomorrow.");

  assert.equal(result.status, "updated");
  assert.equal(result.lead.temperature, "hot");
  assert.equal(applied[0].classification.matchedRule, "booking_intent");
  assert.equal(historyCalls, 0);
});

test("reviewer uses recent clinic context for a short scheduling answer", async () => {
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 5, temperature: "warm", is_closed: false }),
      applyRuleBasedTemperature: async (leadId, classification) => {
        applied.push({ leadId, classification });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [
        { id: 99, role: "assistant", content: "Which branch would you like for the appointment?" },
        { id: 100, role: "user", content: "Puchong" },
      ],
    },
    getBranchNames: () => ["Puchong"],
  });

  const result = await reviewer(13, 100, "Puchong");

  assert.equal(result.status, "updated");
  assert.equal(applied[0].classification.matchedRule, "scheduling_confirmation");
});

test("reviewer does not reuse a stale clinic scheduling question", async () => {
  let applyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 6, temperature: "warm", is_closed: false }),
      applyRuleBasedTemperature: async () => {
        applyCalls += 1;
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [
        { id: 98, role: "assistant", content: "Which branch would you like for the appointment?" },
        { id: 99, role: "user", content: "I am still thinking about it." },
        { id: 100, role: "user", content: "Puchong" },
      ],
    },
    getBranchNames: () => ["Puchong"],
  });

  assert.deepEqual(await reviewer(13, 100, "Puchong"), { status: "unchanged" });
  assert.equal(applyCalls, 0);
});

test("reviewer leaves unclear messages Warm and skips staff-set temperatures", async () => {
  let applyCalls = 0;
  let historyCalls = 0;
  const warmReviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 8, temperature: "warm", is_closed: false }),
      applyRuleBasedTemperature: async () => {
        applyCalls += 1;
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => {
        historyCalls += 1;
        return [];
      },
    },
    getBranchNames: () => ["Puchong"],
  });

  assert.deepEqual(await warmReviewer(14, 101, "How much is it?"), { status: "unchanged" });
  assert.equal(applyCalls, 0);
  assert.equal(historyCalls, 0);

  const hotReviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 9, temperature: "hot", is_closed: false }),
    },
    messagesRepository: {
      getMessagesForContact: async () => {
        historyCalls += 1;
        return [];
      },
    },
    getBranchNames: () => [],
  });

  assert.deepEqual(await hotReviewer(15, 102, "No thanks"), {
    status: "skipped",
    reason: "not-warm",
  });
  assert.equal(historyCalls, 0);
});
