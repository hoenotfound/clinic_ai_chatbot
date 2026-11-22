"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { verifiedResultExampleForConversation } = require("../src/utils/verifiedResultMediaExample");
const { buildConversationPromptContext } = require("../src/utils/conversationPromptContext");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const { buildGeminiRequest } = require("../src/services/geminiService");

const media = [
  { service: "骨盆调理", enabled: true, items: [
    { caption: "第一次骨盆 Before & After", imageUrl: "/api/config/result-media/image/1" },
    { caption: "再给你看一个顾客护理后的 Before & After 😊", verifiedSessionCount: 1,
      imageUrl: "/api/config/result-media/image/2",
      mediaTranslations: { en: { caption: "Another customer Before & After from one session" } } },
  ] },
  { service: "3D 小颜术", enabled: true, items: [
    { caption: "3D verified first treatment", verifiedSessionCount: 1,
      imageUrl: "/api/config/result-media/image/3" },
  ] },
];

function example(messages, text = "一次就这样的效果？", serviceName = "") {
  return verifiedResultExampleForConversation({
    messages, resultMedia: media, serviceName, customerText: text,
  });
}

test("approved second pelvis caption allows a one-session example answer", () => {
  for (const text of ["一次就这样的效果？", "一次就见效果吗？", "做一次就有分别吗？"]) {
    assert.deepEqual(example([
      {role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"},
      {role:"user",content:text},
    ],text), {service:"骨盆调理",verifiedSessionCount:1});
  }
  assert.deepEqual(example([
    {role:"assistant",content:"Another customer Before & After from one session",verifiedOutboundImageUrl:"/api/config/result-media/image/2"},
    {role:"user",content:"Results after one session?"},
  ], "Results after one session?", "骨盆调理"), {service:"骨盆调理",verifiedSessionCount:1});
});

test("cannot infer one-session outcome from another photo, customer/ad text or different service", () => {
  assert.equal(example([{role:"assistant",content:"第一次骨盆 Before & After",verifiedOutboundImageUrl:"/api/config/result-media/image/1"}, {role:"user",content:"一次有分别吗"}]), null);
  assert.equal(example([{role:"user",content:"再给你看一个顾客护理后的 Before & After 😊"}, {role:"user",content:"一次有分别吗"}]), null);
  assert.equal(example([{role:"assistant",content:"Unconfigured promo says first session"}, {role:"user",content:"一次有分别吗"}]), null);
  assert.equal(example([
    {role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/1"},
    {role:"user",content:"一次有分别吗"},
  ]), null, "matching copy with the wrong image cannot prove one session");
  assert.equal(example([
    {role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊"},
    {role:"user",content:"一次有分别吗"},
  ]), null, "a plain text caption is not verified image evidence");
  assert.equal(example([{role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"}, {role:"user",content:"多少钱?"}]), null);
  assert.equal(example([{role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"}, {role:"user",content:"一次有分别吗"}], "一次有分别吗", "3D 小颜术"), null);
  assert.equal(example([{role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"},
    {role:"assistant",content:"第一次骨盆 Before & After",verifiedOutboundImageUrl:"/api/config/result-media/image/1"},
    {role:"user",content:"一次有分别吗"}]), null,
  "a newer unverified result overrides an older verified item");
  assert.equal(example([
    {role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"},
    ...Array.from({length:9}, () => ({role:"assistant",content:"other message"})),
    {role:"user",content:"一次有分别吗"},
  ]), null);
});

test("the real Gemini request receives a trusted example only after matching configured media", () => {
  const saved = {
    resultMedia: config.resultMedia, businessType: config.businessType,
    businessName: config.businessName, clinicName: config.clinicName,
    messagingStyle: config.messagingStyle, sop: config.sop,
  };
  try {
    Object.assign(config, {
      resultMedia: media,
      businessType: "tcm_clinic",
      businessName: "Neutro Sense TCM Centre",
      clinicName: "Neutro Sense TCM Centre",
      sop: "Use verified examples, never guarantee results.",
      messagingStyle: "Answer verified result questions directly first.",
    });
    const messages = [
      {role:"assistant",content:"再给你看一个顾客护理后的 Before & After 😊",verifiedOutboundImageUrl:"/api/config/result-media/image/2"},
      {role:"user",content:"一次就见效果吗？"},
    ];
    const context = buildConversationPromptContext(messages);
    assert.deepEqual(context.verifiedResultMediaExample, {
      service:"骨盆调理",verifiedSessionCount:1,
    });
    assert.equal(context.promotionIntent, false);
    const direct = buildSystemPrompt({ channel:"whatsapp", conversationContext:context });
    assert.match(direct, /VERIFIED RESULT-MEDIA CONTEXT FOR THE CURRENT QUESTION/);
    assert.match(direct, /The clinic-approved Before & After caption just sent/u);
    const generated = buildGeminiRequest(messages,
      {surface:"conversation",channel:"whatsapp"}, "gemini-3.5-flash-lite");
    assert.match(generated.request.config.systemInstruction, /VERIFIED RESULT-MEDIA CONTEXT FOR THE CURRENT QUESTION/);
    assert.match(generated.request.config.systemInstruction, /Do not volunteer prices, trigger price graphics/u);

    const unverified = buildSystemPrompt({
      channel:"whatsapp",conversationContext:buildConversationPromptContext([
        {role:"assistant",content:"第一次骨盆 Before & After",verifiedOutboundImageUrl:"/api/config/result-media/image/1"},
        {role:"user",content:"一次就见效果吗？"},
      ]),
    });
    assert.doesNotMatch(unverified,/VERIFIED RESULT-MEDIA CONTEXT FOR THE CURRENT QUESTION/);
  } finally {
    Object.assign(config, saved);
  }
});
