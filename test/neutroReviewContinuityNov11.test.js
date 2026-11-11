"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {planNeutroReviewContinuation,nonUrgentUrinaryAcknowledgement} =
  require("../src/utils/neutroReviewContinuation");
const {secondaryReplyAttentionAllowedSql,isSecondaryAiReplyEligible} =
  require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const source = pathName => fs.readFileSync(path.join(__dirname,"..",pathName),"utf8");

const prior = [
  {role:"assistant",content:"请问平时身体主要是腰酸、久坐小腹，还是产后调理？"},
  {role:"user",content:"久坐小腹"},
  {role:"assistant",content:"你平时是长时间坐办公室的吗？"},
  {role:"user",content:"是的"},
];

test("Penni: plain yes to staff's office-sitting question has a safe reply", () => {
  const response = planNeutroReviewContinuation({
    customerText:"是的",conversationHistory:prior,language:"zh",
  });
  assert.equal(response.kind,"lifestyle_confirmation");
  assert.match(response.reply,/漏尿.*医生评估/);
  assert.doesNotMatch(response.reply,/保证|治好|改善漏尿|RM\d/);
});

test("yes without a verified lifestyle question cannot override a medical review", () => {
  assert.equal(planNeutroReviewContinuation({
    customerText:"是的",
    conversationHistory:[{role:"assistant",content:"怀孕可以做9D吗？"}],
    language:"zh",
  }),null);
  assert.equal(planNeutroReviewContinuation({
    customerText:"是的",conversationHistory:[],language:"zh",
  }),null);
});

test("unscoped price-first request clarifies treatment without guessing a price", () => {
  const response=planNeutroReviewContinuation({
    customerText:"想了解价格先",conversationHistory:prior,language:"zh",
  });
  assert.equal(response.kind,"unscoped_price_clarification");
  assert.match(response.reply,/徒手/);
  assert.match(response.reply,/脉冲波/);
  assert.doesNotMatch(response.reply,/RM\d/);
});

test("no deterministic recovery for clinical suitability or medication questions", () => {
  for(const text of ["漏尿可以靠骨盆调理好吗？","我怀孕了，9D安全吗？","How much if I have bleeding?"]) {
    assert.equal(planNeutroReviewContinuation({
      customerText:text,conversationHistory:prior,language:"zh",
    }),null,text);
  }
});

test("nonurgent urinary symptom gets safe non-promotional acknowledgement", () => {
  const reply=nonUrgentUrinaryAcknowledgement("单身没结过婚，漏尿问题","zh");
  assert.match(reply,/医生评估/);
  assert.doesNotMatch(reply,/可治|保证|RM|预约|免费/);
  assert.equal(nonUrgentUrinaryAcknowledgement("你好","zh"),null);
});

test("default secondary reply restriction stays closed for pending clinical reviews",()=>{
  const standard=secondaryReplyAttentionAllowedSql("c");
  assert.doesNotMatch(standard,/live_review/);
  const verified=secondaryReplyAttentionAllowedSql("c",{allowReviewContinuation:true});
  assert.match(verified,/live_review.status='pending'/);
  assert.match(verified,/attention_reason LIKE 'AI review requested:%'/);
  assert.match(verified,/c.mode='ai'/);
});

test("pending review continuation requires anchored fresh inbound proof, never fallback",async()=>{
  const env={
    WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
    WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
    WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-01T00:00:00Z",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"12345",
    WHATSAPP_SECONDARY_WABA_ID:"67890",
  };
  const queries=[];
  const database={query:async (sql,params)=>{
    queries.push({sql,params});
    return {rows:[{eligible:true}]};
  }};
  assert.equal(await isSecondaryAiReplyEligible(9006,{
    env,database,allowReviewContinuation:true,
  }),true);
  assert.doesNotMatch(queries[0].sql,/live_review/);
  assert.equal(await isSecondaryAiReplyEligible(9006,{
    env,database,allowReviewContinuation:true,inboundMessageId:18336,
  }),true);
  assert.match(queries[1].sql,/live_review/);
  assert.match(queries[1].sql,/inbound.id=\$5/);
  assert.deepEqual(queries[1].params.slice(-1),[18336]);
  assert.equal(await isSecondaryAiReplyEligible(9006,{
    env,database,allowReviewContinuation:true,inboundMessageId:-1,
  }),false);
});

test("AI reply transport forwards narrow inbound anchor; followups and media do not",()=>{
  const server=source("src/server.js");
  const dispatch=source("src/services/whatsappSecondaryStaffDispatch.js");
  const prompt=source("src/utils/systemPrompt.js");
  assert.match(server,/reviewReplyToInboundMessageId: savedInbound.id/g);
  assert.match(server,/anchorMessageId: reviewContinuationAnchor/);
  assert.match(server,/reviewContinuationTextOnly/);
  assert.match(server,/nonUrgentUrinaryAcknowledgement\(text, mediaLanguage\)/);
  assert.match(dispatch,/origin==="ai_reply" && anchorMessageId != null/);
  assert.match(prompt,/simple affirmative to a prior question about sitting/);
});
