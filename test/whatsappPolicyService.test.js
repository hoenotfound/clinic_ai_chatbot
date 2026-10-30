const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../src/services/whatsappPolicyService");
const { pool } = require("../src/db/db");

test("detects common WhatsApp opt-out requests in supported chat languages", () => {
  const optOuts = [
    "STOP",
    "unsubscribe",
    "don't message me",
    "Please stop messaging me",
    "不要再发消息",
    "不要联系我",
    "jangan mesej saya",
    "tak nak whatsapp",
    "Stop promotions",
    "不要再发优惠",
    "停止推广消息",
    "jangan hantar promosi",
    "tak nak promosi",
    "Please stop sending me promotions",
    "Don't send me offers",
    "Stop marketing messages",
    "Unsubscribe from marketing",
    "我不想再收到优惠消息",
    "saya tak nak promosi",
    "Please stop sending me promotions, thanks",
    "Can you please stop all these promotional offers?",
    "Please unsubscribe me from marketing updates, thank you.",
    "I don't want any more offers",
    "不要再给我发优惠了",
    "优惠信息不要再发给我了，谢谢",
    "请不要再发优惠活动给我，谢谢",
    "Saya tak nak terima promosi lagi, terima kasih",
    "Jangan hantar promosi lagi ya",
    "Stop promo",
    "Unsubscribe from promos",
    "Unsubcribe from Promos",
    "Unsubscribe from All",
  ];

  for (const text of optOuts) {
    assert.equal(policy.isOptOutText(text), true, text);
  }
});

test("recognizes natural opt-out requests that were missed in live Neutro conversations", () => {
  for (const [message, expected] of [
    ["考虑先 请禁止一直发信息 谢谢", "all"],
    ["请不要再发信息给我，谢谢", "all"],
    ["别再给我发消息了", "all"],
    ["Pls stop to send auto massage ya", "marketing"],
    ["Pls stop to send auto message ya", "marketing"],
    ["Please stop sending automated messages", "marketing"],
    ["Please stop the follow-ups", "marketing"],
    ["Jangan hantar mesej auto lagi ya", "marketing"],
    ["Please don't send me messages again", "all"],
    ["Please don't send me automated messages", "marketing"],
    ["I don't want any more automatic messages", "marketing"],
    ["请不要再联系我", "all"],
    ["别再打扰我了", "all"],
    ["Please don't contact me again", "all"],
    ["Tolong jangan mesej saya lagi", "all"],
  ]) {
    assert.equal(policy.classifyOptOutText(message), expected, message);
  }
});

test("does not treat normal customer messages as opt-out requests", () => {
  const normalMessages = [
    "what is the price?",
    "can I book Saturday?",
    "stop by at 3pm can?",
    "jangan risau",
    "可以联系我吗",
    "Any offers for 3D treatment?",
    "Do you still have promotions?",
    "我想了解优惠配套",
    "Does the promotion stop today?",
    "Don't stop automated messages",
    "Please stop by tomorrow",
    "Can you explain how automated follow-ups work?",
    "Does the automated message stop after one day?",
    "I want to stop my follow-up appointment",
    "Please don't stop messaging me",
    "Don't stop contacting me",
    "Don't send me automated service pricing",
  ];

  for (const text of normalMessages) {
    assert.equal(policy.isOptOutText(text), false, text);
  }
});

test("blocks any outbound message immediately after an opt-out", () => {
  const optOutAt = new Date("2026-09-03T10:00:00.000Z");
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: optOutAt,
      latest_inbound_at: optOutAt,
    },
    new Date("2026-09-03T10:01:00.000Z")
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "opted_out");
});

test("allows service replies when the customer starts a new chat after opting out", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose: "service" }
  );

  assert.equal(result.allowed, true);
});

test("keeps automated marketing blocked after opt-out even if customer later asks for support", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose: "marketing" }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "opted_out");
});

test("still blocks service replies when the 24-hour customer window has expired", () => {
  const result = policy.evaluateFreeformState(
    {
      whatsapp_opt_out_at: null,
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T10:00:00.000Z")
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_customer_service_window");
});

test("applies the same standard window to Facebook Messenger", () => {
  const open = policy.evaluateFreeformState(
    {
      channel: "facebook",
      latest_inbound_at: new Date("2026-09-03T10:00:00.000Z"),
    },
    new Date("2026-09-04T09:59:00.000Z")
  );
  assert.equal(open.allowed, true);

  const closed = policy.evaluateFreeformState(
    {
      channel: "facebook",
      latest_inbound_at: new Date("2026-09-03T10:00:00.000Z"),
    },
    new Date("2026-09-04T10:00:00.000Z")
  );
  assert.equal(closed.allowed, false);
  assert.equal(closed.code, "outside_customer_service_window");
  assert.match(closed.message, /Facebook Messenger/);
});

test("Instagram requires a customer message before opening its standard window", () => {
  const result = policy.evaluateFreeformState(
    { channel: "instagram", latest_inbound_at: null },
    new Date("2026-09-03T10:00:00.000Z")
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "no_customer_message");
  assert.match(result.message, /Instagram/);
});

test("WhatsApp opt-out fields do not create a social-channel opt-out state", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "facebook",
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose: "marketing" }
  );

  assert.equal(result.allowed, true);
});

test("allows a real Messenger staff reply from 24 hours through the 7-day Human Agent window", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "facebook",
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T12:00:00.000Z"),
    { purpose: "human_agent", humanAgentEnabled: true }
  );

  assert.equal(result.allowed, true);
  assert.equal(result.humanAgentRequired, true);
  assert.equal(
    result.humanAgentWindowEndsAt.toISOString(),
    "2026-09-08T10:00:00.000Z"
  );
});

test("keeps automated Messenger replies blocked after the standard 24-hour window", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "facebook",
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T12:00:00.000Z"),
    { purpose: "service" }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_customer_service_window");
});

test("blocks Instagram staff replies when the 7-day Human Agent window has ended", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "instagram",
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-08T10:00:00.000Z"),
    { purpose: "human_agent", humanAgentEnabled: true }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_human_agent_window");
  assert.match(result.message, /7-day Human Agent window/);
});

test("does not extend WhatsApp with the Meta Human Agent purpose", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "whatsapp",
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T12:00:00.000Z"),
    { purpose: "human_agent", humanAgentEnabled: true }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_customer_service_window");
});

test("manual staff purpose requires both the runtime flag and channel configuration", () => {
  const configured = {
    FACEBOOK_PAGE_ID: "fb-page",
    FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token",
    INSTAGRAM_PAGE_ID: "ig-page",
    INSTAGRAM_PAGE_ACCESS_TOKEN: "ig-token",
  };
  const disabled = {
    ...configured,
    META_HUMAN_AGENT_ENABLED: "false",
  };
  const enabled = {
    ...configured,
    META_HUMAN_AGENT_ENABLED: "true",
  };
  const facebookOnly = {
    META_HUMAN_AGENT_ENABLED: "true",
    FACEBOOK_PAGE_ID: "fb-page",
    FACEBOOK_PAGE_ACCESS_TOKEN: "fb-token",
  };

  assert.equal(policy.manualStaffPurpose("whatsapp", enabled), "service");
  assert.equal(policy.manualStaffPurpose({ channel: "whatsapp" }, enabled), "service");
  assert.equal(policy.manualStaffPurpose("facebook", disabled), "service");
  assert.equal(policy.manualStaffPurpose({ channel: "instagram" }, disabled), "service");
  assert.equal(policy.manualStaffPurpose("facebook", enabled), "human_agent");
  assert.equal(policy.manualStaffPurpose({ channel: "instagram" }, enabled), "human_agent");
  assert.equal(policy.manualStaffPurpose("instagram", facebookOnly), "service");
});

test("WhatsApp manual staff policy still allows a service reply after the customer reinitiates following opt-out", () => {
  const purpose = policy.manualStaffPurpose(
    { channel: "whatsapp" },
    { META_HUMAN_AGENT_ENABLED: "true" }
  );
  const result = policy.evaluateFreeformState(
    {
      channel: "whatsapp",
      whatsapp_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
      latest_inbound_at: new Date("2026-09-03T11:00:00.000Z"),
    },
    new Date("2026-09-03T11:05:00.000Z"),
    { purpose }
  );

  assert.equal(purpose, "service");
  assert.equal(result.allowed, true);
});

test("Human Agent purpose stays blocked after 24 hours when the runtime feature is disabled", () => {
  const result = policy.evaluateFreeformState(
    {
      channel: "facebook",
      latest_inbound_at: new Date("2026-09-01T10:00:00.000Z"),
    },
    new Date("2026-09-02T12:00:00.000Z"),
    { purpose: "human_agent", humanAgentEnabled: false }
  );

  assert.equal(result.allowed, false);
  assert.equal(result.code, "outside_customer_service_window");
  assert.equal(result.humanAgentWindowEndsAt, null);
  assert.match(result.message, /must message again/i);
  assert.doesNotMatch(result.message, /Human Agent/);
});

test("classifies marketing-only and global WhatsApp opt-outs separately", () => {
  for (const text of ["Stop promotions", "Stop promo", "Unsubscribe from promos", "Unsubcribe from Promos"]) {
    assert.equal(policy.classifyOptOutText(text), "marketing", text);
  }
  for (const text of ["STOP", "unsubscribe", "Unsubscribe from All", "Stop all", "don't contact me"]) {
    assert.equal(policy.classifyOptOutText(text), "all", text);
  }
});

test("marketing-only opt-out blocks marketing but keeps service replies available", () => {
  const state = {
    channel: "whatsapp",
    whatsapp_marketing_opt_out_at: new Date("2026-09-03T10:00:00.000Z"),
    latest_inbound_at: new Date("2026-09-03T10:30:00.000Z"),
  };
  const now = new Date("2026-09-03T10:35:00.000Z");

  const marketing = policy.evaluateFreeformState(state, now, { purpose: "marketing" });
  const service = policy.evaluateFreeformState(state, now, { purpose: "service" });

  assert.equal(marketing.allowed, false);
  assert.equal(marketing.code, "marketing_opted_out");
  assert.equal(service.allowed, true);
});

test("marketing-only opt-out blocks MARKETING templates but keeps UTILITY templates eligible", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({
    rows: [{
      id: 42,
      channel: "whatsapp",
      whatsapp_number: "60123456789",
      whatsapp_opt_in_at: new Date("2026-09-29T10:00:00.000Z"),
      whatsapp_opt_in_source: "clinic form",
      whatsapp_opt_out_at: null,
      whatsapp_opt_out_source: null,
      whatsapp_marketing_opt_out_at: new Date("2026-09-29T11:00:00.000Z"),
      whatsapp_marketing_opt_out_source: "customer_quick_reply",
      latest_inbound_at: new Date("2026-09-29T11:00:00.000Z"),
    }],
  });

  const contact = { id: 42, channel: "whatsapp" };
  const utility = await policy.checkTemplateAllowed(contact, { category: "UTILITY" });
  const marketing = await policy.checkTemplateAllowed(contact, { category: "MARKETING" });

  assert.equal(utility.allowed, true);
  assert.equal(marketing.allowed, false);
  assert.equal(marketing.code, "marketing_opted_out");
  assert.equal(
    marketing.state.whatsapp_marketing_opt_out_source,
    "customer_quick_reply"
  );
});


test("Messenger and Instagram marketing opt-outs block pricing even after a later customer reply",()=>{
  for (const channel of ["facebook","instagram"]) {
    const state={
      channel,
      latest_inbound_at:new Date("2026-10-08T12:00:00Z"),
      social_marketing_opt_out_at:new Date("2026-10-08T08:00:00Z"),
    };
    const now=new Date("2026-10-08T12:05:00Z");
    const marketing=policy.evaluateFreeformState(state,now,{purpose:"marketing"});
    assert.equal(marketing.allowed,false,channel);
    assert.equal(marketing.code,"marketing_opted_out");
    assert.equal(policy.evaluateFreeformState(state,now,{purpose:"service"}).allowed,true);
    assert.equal(policy.evaluateFreeformState({...state,
      social_opt_out_at:new Date("2026-10-08T07:00:00Z")},
      now,{purpose:"marketing"}).allowed,false);
  }
});

test("multilingual STOP promotions only revokes marketing, not service replies", () => {
  for (const text of ["Stop promotions","不要再发优惠","停止推广消息","jangan hantar promosi","tak nak promosi"]) {
    assert.equal(policy.classifyOptOutText(text), "marketing", text);
  }
  assert.equal(policy.classifyOptOutText("Neutro Sense TCM 有优惠可以 WhatsApp 发给我"), null);
});

test("MARKETING templates require verified CRM consent and a real consent event; UTILITY does not", async (t) => {
  const original=pool.query;
  t.after(()=>{pool.query=original;});
  const queries=[];
  let leadConsent="unknown", hasEvidence=false;
  pool.query=async (sql) => {
    queries.push(sql);
    if (sql.includes("FROM leads l")) return {rows:[{
      marketing_consent:leadConsent,has_evidence:hasEvidence,
    }]};
    return {rows:[{
      id:42,channel:"whatsapp",whatsapp_number:"60123456789",
      whatsapp_opt_in_at:new Date("2026-10-09T01:00:00Z"),
      whatsapp_opt_in_source:"customer message",
      whatsapp_opt_out_at:null,whatsapp_marketing_opt_out_at:null,
    }]};
  };
  const contact={id:42,channel:"whatsapp"};
  assert.equal((await policy.checkTemplateAllowed(contact,{category:"UTILITY"})).allowed,true);
  assert.equal(queries.length,1);
  const missing=await policy.checkTemplateAllowed(contact,{category:"MARKETING"});
  assert.equal(missing.allowed,false);
  assert.equal(missing.code,"marketing_consent_unverified");
  leadConsent="opted_in";
  assert.equal((await policy.checkTemplateAllowed(contact,{category:"MARKETING"})).allowed,false,
    "CRM checkbox alone is not verification");
  hasEvidence=true;
  assert.equal((await policy.checkTemplateAllowed(contact,{category:"MARKETING"})).allowed,true);
});

test("a marketing STOP can include an independent service question, never a pricing question", () => {
  const parse = policy.extractQuestionAfterMarketingOptOut;
  assert.equal(parse("不要再发优惠了，我想问骨盆护理要多久？"), "我想问骨盆护理要多久？");
  assert.equal(parse("Please stop sending me promotions, how long does pelvic treatment take?"),
    "how long does pelvic treatment take?");
  assert.equal(parse("不要再发优惠了，请问营业时间？"), "请问营业时间？");
  assert.equal(parse("Stop promotions"), null);
  assert.equal(parse("Stop all, how long does pelvic treatment take?"), null);
  assert.equal(parse("不要再发优惠了，套餐多少钱？"), null);
  assert.equal(parse("不要再发优惠了，有优惠可以发我看看"), null);
});


test("marketing refusal with a separate explanatory question remains a STOP plus service request", () => {
  for (const value of [
    "No promotions please, just explain pelvic treatment",
    "No more offers please. How long does pelvic treatment take?",
    "Don't send me promotions, can you explain how 3D works?",
    "Stop promotions. What time are you open?",
    "No promos thanks",
  ]) assert.equal(policy.classifyOptOutText(value), "marketing", value);
  assert.equal(policy.extractQuestionAfterMarketingOptOut(
    "No promotions please, just explain pelvic treatment"
  ), "just explain pelvic treatment");
  assert.equal(policy.extractQuestionAfterMarketingOptOut(
    "No more offers please. How long does pelvic treatment take?"
  ), "How long does pelvic treatment take?");
  for (const value of [
    "Any promotions for pelvic treatment?",
    "No promotions available today?",
    "What offers do you have?",
  ]) assert.equal(policy.classifyOptOutText(value), null, value);
  for (const channel of ["whatsapp", "facebook", "instagram"]) {
    const result = policy.evaluateFreeformState({
      channel,
      social_marketing_opt_out_at: new Date("2026-10-12T02:00:00Z"),
      whatsapp_marketing_opt_out_at: new Date("2026-10-12T02:00:00Z"),
      latest_inbound_at: new Date("2026-10-12T02:01:00Z"),
    }, new Date("2026-10-12T02:03:00Z"), { purpose: "marketing" });
    assert.equal(result.code, "marketing_opted_out", channel);
  }
});
