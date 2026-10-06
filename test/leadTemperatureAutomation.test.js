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
    "I'll come tomorrow.",
    "I'm on my way.",
    "See you at 3pm.",
    "Can you reserve first?",
    "Ask your staff to call me.",
    "Saya akan datang esok.",
    "Saya dah on the way.",
    "Boleh reserve dulu?",
    "Tolong suruh staff call saya.",
    "我明天会过去。",
    "我已经在路上了。",
    "明天见。",
    "可以先帮我留位吗？",
    "叫客服联系我。",
  ];

  for (const messageText of examples) {
    const result = classifyTemperatureMessage({ messageText });
    assert.equal(result?.temperature, "hot", messageText);
    assert.equal(result?.matchedRule, "booking_intent", messageText);
  }
});

test("clear purchase, package acceptance, and payment intent becomes Hot", () => {
  const examples = [
    "I want this package.",
    "I want Package A.",
    "I want the RM388 promo.",
    "I want to take this promotion.",
    "I'll go with this package.",
    "How can I make payment?",
    "Please send me the payment link.",
    "Saya nak ambil pakej ini.",
    "Saya nak pakej A.",
    "Saya nak promo RM388.",
    "Saya mahu teruskan rawatan ini.",
    "Macam mana nak bayar?",
    "Boleh bagi payment link?",
    "我要这个配套。",
    "我要A配套。",
    "我想要这个优惠。",
    "我想付款。",
    "怎么付定金？",
    "发给我付款链接。",
    "This is expensive, but I'll take this package.",
    "这个有点贵，不过我要这个配套。",
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
    "I don't want to visit.",
    "I do not want to reserve.",
    "I am not going to come.",
    "Saya tak berminat.",
    "Saya tak nak book.",
    "Saya tak nak datang.",
    "Saya tidak mahu visit.",
    "Jangan hubungi saya lagi.",
    "谢谢不用了。",
    "我不想去你们诊所。",
    "我不要到店。",
    "不要再联系我。",
    "I've already booked another clinic.",
    "I am not proceeding with this treatment anymore.",
    "I will not proceed with your clinic.",
    "It is too far, so I won't come.",
    "Saya tak mahu teruskan rawatan ini.",
    "我已经预约了别的诊所。",
    "我不继续了。",
  ];

  for (const messageText of examples) {
    const result = classifyTemperatureMessage({ messageText });
    assert.equal(result?.temperature, "cold", messageText);
    assert.equal(result?.matchedRule, "explicit_rejection", messageText);
  }

  for (const messageText of [
    "Please stop messaging me.",
    "Sorry, wrong number.",
    "Jangan hubungi saya lagi.",
    "不要再联系我。",
  ]) {
    assert.equal(
      classifyTemperatureMessage({ messageText })?.rejectionStrength,
      "absolute",
      messageText
    );
  }

  assert.equal(
    classifyTemperatureMessage({ messageText: "No thanks, I am not interested." })
      ?.rejectionStrength,
    "absolute"
  );
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
    "This package is too expensive, let me think about it.",
    "Do I need to pay a deposit?",
    "Is a deposit required?",
    "Any discount if I take Package A?",
    "I live in Johor. Do you only have a PJ branch?",
    "Saya nak fikir dulu sebab agak mahal.",
    "Perlu saya bayar deposit ke?",
    "这个配套太贵，我考虑一下。",
    "需要付定金吗？",
    "No thanks.",
    "If you can give a discount, I will take Package A.",
    "Kalau ada diskaun saya nak ambil pakej A.",
    "如果有折扣我就要这个配套。",
    "I don't want this package.",
    "Saya tak nak pakej ini.",
    "我不要这个套餐，但我想了解另一个。",
    "If I decide next month, can I book online?",
    "If I want to book later, how do I do it?",
    "I'm coming to KL next month, do you have a branch there?",
    "我来了解一下。",
    "Just asking how booking works.",
    "Kalau saya nanti nak book, boleh buat online?",
    "如果我之后想预约，可以线上预约吗？",
    "",
  ];

  for (const messageText of examples) {
    assert.equal(classifyTemperatureMessage({ messageText }), null, messageText);
  }
});

test("reviewer recovers Cold leads to Warm on renewed interest and cools Hot leads on explicit hesitation", async () => {
  let activeLead = { id: 20, temperature: "cold", is_closed: false };
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => activeLead,
      applyRuleBasedTemperature: async (leadId, classification, currentTemperature) => {
        applied.push({ leadId, classification, currentTemperature });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [],
    },
    getBranchNames: () => [],
  });

  const renewed = await reviewer(21, 201, "How much is the pelvis treatment now?");
  assert.equal(renewed.status, "updated");
  assert.equal(renewed.lead.temperature, "warm");
  assert.equal(renewed.classification.matchedRule, "renewed_interest");
  assert.equal(renewed.classification.warmStrength, "interest");
  assert.equal(applied[0].currentTemperature, "cold");

  activeLead = { id: 20, temperature: "cold", is_closed: false };
  const promoRenewed = await reviewer(21, 2012, "Any promo now?");
  assert.equal(promoRenewed.status, "updated");
  assert.equal(promoRenewed.lead.temperature, "warm");
  assert.equal(promoRenewed.classification.matchedRule, "renewed_interest");

  activeLead = { id: 20, temperature: "cold", is_closed: false };
  const depositRenewed = await reviewer(21, 2013, "Do I need to pay a deposit?");
  assert.equal(depositRenewed.status, "updated");
  assert.equal(depositRenewed.lead.temperature, "warm");
  assert.equal(depositRenewed.classification.warmStrength, "interest");

  activeLead = { id: 20, temperature: "cold", is_closed: false };
  const hesitantOnly = await reviewer(21, 2014, "Maybe later, not now.");
  assert.equal(hesitantOnly.status, "unchanged");

  activeLead = { id: 20, temperature: "cold", is_closed: false };
  const rejectedTreatmentOnly = await reviewer(21, 2015, "Saya tak nak rawatan ini.");
  assert.equal(rejectedTreatmentOnly.status, "unchanged");

  activeLead = { id: 21, temperature: "hot", is_closed: false };
  const cooled = await reviewer(22, 202, "RM388 is a bit expensive, let me think first.");
  assert.equal(cooled.status, "updated");
  assert.equal(cooled.lead.temperature, "warm");
  assert.equal(cooled.classification.matchedRule, "explicit_hesitation");
  assert.equal(cooled.classification.warmStrength, "cooling");
  assert.equal(applied[3].currentTemperature, "hot");

  activeLead = { id: 22, temperature: "hot", is_closed: false };
  const paymentQuestion = await reviewer(23, 203, "Do I need to pay a deposit?");
  assert.equal(paymentQuestion.status, "unchanged");
  assert.equal(applied.length, 4);
});

test("distance and different-state location stay Warm unless the customer withdraws", () => {
  for (const messageText of [
    "I live in Johor. Is your clinic only in PJ?",
    "I'm from Penang, PJ is quite far.",
    "Saya di Melaka, ada branch dekat sini?",
    "我住在槟城，PJ有点远。",
  ]) {
    assert.equal(classifyTemperatureMessage({ messageText }), null, messageText);
  }

  for (const messageText of [
    "I'm from Johor but I want to book Saturday.",
    "Saya dari Melaka tapi saya nak buat appointment Sabtu.",
    "我住在槟城，不过我想预约星期六。",
  ]) {
    assert.equal(classifyTemperatureMessage({ messageText })?.temperature, "hot", messageText);
  }
});

test("package acceptance becomes Hot when it directly answers a sales next-step prompt", () => {
  const examples = [
    {
      messageText: "Yes please",
      previousClinicMessage: "Would you like to proceed with Package A?",
    },
    {
      messageText: "Package A",
      previousClinicMessage: "Which package would you like to proceed with?",
    },
    {
      messageText: "A",
      previousClinicMessage: "Which package would you like to proceed with?",
    },
    {
      messageText: "可以",
      previousClinicMessage: "要不要继续这个配套？",
    },
  ];

  for (const example of examples) {
    const result = classifyTemperatureMessage(example);
    assert.equal(result?.temperature, "hot", example.messageText);
    assert.equal(result?.matchedRule, "scheduling_confirmation", example.messageText);
  }

  assert.equal(classifyTemperatureMessage({ messageText: "Package A" }), null);
  assert.equal(classifyTemperatureMessage({
    messageText: "Package A",
    previousClinicMessage: "Which package would you like to know more about?",
  }), null);
  assert.equal(classifyTemperatureMessage({
    messageText: "Maybe later",
    previousClinicMessage: "Would you like to proceed with Package A?",
  }), null);
});

test("declining one date while offering another is not a Cold rejection", () => {
  const examples = [
    {
      messageText: "I don't want to visit Saturday, Sunday works for me.",
      previousClinicMessage: "Which day would you like to visit?",
    },
    {
      messageText: "I won't come Saturday. Sunday is okay.",
      previousClinicMessage: "Which day would you like to visit?",
    },
    {
      messageText: "Saya tak nak datang Sabtu, Ahad boleh.",
      previousClinicMessage: "Hari mana sesuai untuk datang?",
    },
  ];

  for (const example of examples) {
    const result = classifyTemperatureMessage(example);
    assert.equal(result?.temperature, "hot", example.messageText);
    assert.equal(result?.matchedRule, "scheduling_confirmation", example.messageText);
  }

  assert.equal(
    classifyTemperatureMessage({
      messageText: "I don't want to visit Saturday, Sunday works for me.",
    }),
    null
  );
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
    getBranchNames: () => ["Puchong"],
  });

  const result = await reviewer(12, 90, "I would like to book tomorrow.");

  assert.equal(result.status, "updated");
  assert.equal(result.lead.temperature, "hot");
  assert.equal(applied[0].classification.matchedRule, "booking_intent");
  assert.equal(applied[0].currentTemperature, "warm");
  assert.equal(historyCalls, 0);
});

test("reviewer recovers Cold leads and only cools Hot leads for absolute rejection", async () => {
  let activeLead = { id: 12, temperature: "cold", is_closed: false };
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => activeLead,
      applyRuleBasedTemperature: async (leadId, classification, currentTemperature) => {
        applied.push({ leadId, classification, currentTemperature });
        return { id: leadId, temperature: classification.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [],
    },
    getBranchNames: () => [],
  });

  const recovered = await reviewer(17, 104, "Actually, I would like to book tomorrow.");
  assert.equal(recovered.status, "updated");
  assert.equal(recovered.lead.temperature, "hot");
  assert.equal(applied[0].currentTemperature, "cold");

  activeLead = { id: 13, temperature: "hot", is_closed: false };
  const finalDecline = await reviewer(18, 105, "No thanks, I am not interested.");
  assert.equal(finalDecline.status, "updated");
  assert.equal(finalDecline.lead.temperature, "cold");
  assert.equal(applied[1].currentTemperature, "hot");
  assert.equal(applied[1].classification.rejectionStrength, "absolute");

  activeLead = { id: 14, temperature: "hot", is_closed: false };
  const stopContact = await reviewer(18, 106, "Please stop messaging me.");
  assert.equal(stopContact.status, "updated");
  assert.equal(stopContact.lead.temperature, "cold");
  assert.equal(applied[2].currentTemperature, "hot");
  assert.equal(applied[2].classification.rejectionStrength, "absolute");
});

test("reviewer uses recent clinic context for a short scheduling answer", async () => {
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({
        id: 5,
        temperature: "warm",
        is_closed: false,
        started_message_id: 99,
      }),
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
      getActiveLeadForContact: async () => ({
        id: 6,
        temperature: "warm",
        is_closed: false,
        started_message_id: 98,
      }),
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

test("reviewer does not reuse scheduling context from a previous lead journey", async () => {
  let applyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({
        id: 7,
        temperature: "warm",
        is_closed: false,
        started_message_id: 100,
      }),
      applyRuleBasedTemperature: async () => {
        applyCalls += 1;
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [
        { id: 99, role: "assistant", content: "Which day would you like to visit?" },
        { id: 100, role: "user", content: "Saturday" },
      ],
    },
    getBranchNames: () => [],
  });

  assert.deepEqual(await reviewer(13, 100, "Saturday"), { status: "unchanged" });
  assert.equal(applyCalls, 0);
});

test("a staff-created journey excludes messages sent before the lead was created", async () => {
  let applyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({
        id: 11,
        temperature: "warm",
        is_closed: false,
        started_message_id: null,
        created_at: "2026-08-28T10:00:00.000Z",
      }),
      applyRuleBasedTemperature: async () => {
        applyCalls += 1;
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [
        {
          id: 99,
          role: "assistant",
          content: "Which day would you like to visit?",
          created_at: "2026-08-28T09:50:00.000Z",
        },
        {
          id: 100,
          role: "user",
          content: "Saturday",
          created_at: "2026-08-28T10:05:00.000Z",
        },
      ],
    },
    getBranchNames: () => [],
  });

  assert.deepEqual(await reviewer(13, 100, "Saturday"), { status: "unchanged" });
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

  const lockedReviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({
        id: 10,
        temperature: "warm",
        temperature_locked: true,
        is_closed: false,
      }),
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
    getBranchNames: () => [],
  });

  assert.deepEqual(await lockedReviewer(16, 103, "Please book me tomorrow"), {
    status: "skipped",
    reason: "staff-controlled",
  });
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

  const hotResult = await hotReviewer(15, 102, "No thanks");
  assert.equal(hotResult.status, "unchanged");
  assert.equal(historyCalls, 0);
});
