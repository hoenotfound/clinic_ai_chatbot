"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {resolveFixedAdFirstReply}=require("../src/utils/fixedAdFirstReply");
const {isEarlyContextualAdEnquiry}=require("../src/utils/resultMediaTrigger");
const {recordVerifiedFirstAd}=require("../src/db/whatsapp131060FirstAdRepo");

const original="📎 [Customer sent a WhatsApp message that could not be displayed]";
const customer="Hi, I'd like to know more about this";
const now=Date.parse("2026-11-06T02:00:00Z");
const service="骨盆调理";
const config={enabled:true,replies:[{
  service,translations:{en:"Welcome to pelvic care. What would you like to know?"},
}]};
const services=[{name:service}];
const aliases=[{alias:"pelvic",officialService:service}];
const ad={
  attributedAt:new Date(now-3000).toISOString(),
  serviceHint:service,serviceHintSource:"creative",headline:service,
};
const fixedInput={
  config,customerText:customer,language:"en",
  metaAdContext:ad,metaAdCreativeService:service,
  services,serviceAliases:aliases,businessName:"Neutro Sense TCM Centre",now,
  isFirstMessage:true,conversationHistory:[{role:"user",content:customer}],
};

test("131060 placeholder alone cannot authorize a first fixed advertising reply",()=>{
  assert.equal(resolveFixedAdFirstReply({
    ...fixedInput,
    conversationHistory:[
      {role:"user",content:original},
      {role:"user",content:customer},
    ],
  }),null);
  assert.equal(resolveFixedAdFirstReply({
    ...fixedInput,isFirstMessage:false,
  }),null);
  assert.equal(resolveFixedAdFirstReply(fixedInput)?.reply,config.replies[0].translations.en,
    "only the independently verified first readable customer turn can use fixed intro");
});

test("verified first readable ad restores early contextual result eligibility only",()=>{
  assert.equal(isEarlyContextualAdEnquiry({
    customerText:customer,priorCustomerTexts:[original],
  }),false);
  assert.equal(isEarlyContextualAdEnquiry({
    customerText:customer,priorCustomerTexts:[],
  }),true);
  assert.equal(isEarlyContextualAdEnquiry({
    customerText:customer,priorCustomerTexts:["What is the price?"],
  }),false,"a substantive earlier question still blocks creative-only results");
  assert.equal(isEarlyContextualAdEnquiry({
    customerText:customer,priorCustomerTexts:null,
  }),false,"unavailable full history must fail closed");
});

test("complete runtime wiring uses durable evidence for fixed intro, AI and media",()=>{
  const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const inbound=fs.readFileSync(path.join(__dirname,
    "../src/services/inboundMessageClaimService.js"),"utf8");
  const eligibility=fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappSecondaryAdsOnlyEligibility.js"),"utf8");
  const prunedJobs=fs.readFileSync(path.join(__dirname,
    "../src/db/inboundProcessingRepo.js"),"utf8");
  assert.match(inbound,/verifiedUnavailableFirstAd[\s\S]*?recordVerifiedFirstAd/);
  assert.match(server,/let verifiedFirstReadableAd = isVerifiedAdInbound/);
  assert.match(server,/firstAdProofRepo\.getVerifiedFirstAdMessage/);
  assert.match(server,/preclaimed\?\.verifiedUnavailableFirstAd !== true/);
  assert.doesNotMatch(server,/history\.length === 2\s*&&\s*preclaimed\?\.verifiedUnavailableFirstAd/);
  assert.match(server,/isFirstMessage:\s*wasFirstMessage\s*===\s*true\s*\|\|\s*verifiedFirstReadableAd/);
  assert.match(server,/conversationHistory:\s*verifiedFirstReadableAd\s*\?\s*history\.slice\(-1\)/);
  assert.match(server,/const modelReplyHistory\s*=\s*verifiedFirstReadableAd[\s\S]*?\?\s*replyHistory\.slice\(-1\)[\s\S]*?ai\.getReply\(modelReplyHistory,\s*replyOptions\)/);
  assert.match(server,/priorCustomerTexts:\s*verifiedFirstReadableAd[\s\S]*?\?\s*\[\]\s*:\s*verifiedPriorCustomerTexts/);
  assert.match(eligibility,/FROM whatsapp_secondary_131060_first_ads verified_first/);
  assert.doesNotMatch(eligibility,/unavailable_job\.incoming_payload/);
  assert.match(prunedJobs,/DELETE FROM inbound_processing_jobs/);
});

test("durable first-ad proof validates IDs before contacting Neon",async()=>{
  let called=0;
  const db={query:async()=>{called++;throw Error("should not query");}};
  for(const args of [
    {contactId:0,inboundMessageId:3,adId:"123"},
    {contactId:1,inboundMessageId:0,adId:"123"},
    {contactId:1,inboundMessageId:3,adId:null},
    {contactId:1,inboundMessageId:3,adId:"bad ad id with spaces"},
  ])assert.equal(await recordVerifiedFirstAd(args,db),null);
  assert.equal(called,0);
});
