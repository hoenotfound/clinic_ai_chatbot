"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveContactPricingMode}=require("../src/utils/pricingTestContact");
const {buildSystemPrompt,normalizeOptions}=require("../src/utils/systemPrompt");
const config=require("../src/config/clinicConfig");

test("operator pricing test enables only an exact WhatsApp contact in Shadow for a bounded duration",()=>{
 const now=Date.parse("2026-11-24T08:00:00Z");
 const env={AI_PRICING_TEST_CONTACT_ID:"123",AI_PRICING_TEST_EXPIRES_AT:"2026-11-24T09:00:00Z"};
 const args={baseMode:"shadow",contactId:123,channel:"whatsapp",now,env};
 assert.equal(resolveContactPricingMode(args),"enabled");
 for(const change of [
   {contactId:124},{contactId:null},{contactId:"0123"},{channel:"facebook"},
   {channel:"instagram"},{env:{}},{now:Date.parse("2026-11-24T09:00:00Z")},
   {env:{...env,AI_PRICING_TEST_EXPIRES_AT:"invalid"}},
   {env:{...env,AI_PRICING_TEST_EXPIRES_AT:"2026-11-26T08:00:00Z"}},
   {env:{...env,AI_PRICING_TEST_CONTACT_ID:"123,124"}},
 ])assert.equal(resolveContactPricingMode({...args,...change}),"shadow",JSON.stringify(change));
 assert.equal(resolveContactPricingMode({...args,baseMode:"off"}),"off");
 assert.equal(resolveContactPricingMode({...args,baseMode:"enabled"}),"enabled");
});

test("per-inbound pricing mode survives option normalization without mutating global config",()=>{
 const previous=config.aiPricingIntentMode;
 try{
   config.aiPricingIntentMode="shadow";
   const options={surface:"conversation",channel:"whatsapp",contactId:123,pricingIntentMode:"enabled"};
   const enabled=buildSystemPrompt(normalizeOptions(options));
   const shadow=buildSystemPrompt(normalizeOptions({...options,contactId:124,pricingIntentMode:"shadow"}));
   assert.ok(enabled.includes("Use the whole recent conversation, including authenticated staff replies"));
   assert.ok(!shadow.includes("Use the whole recent conversation, including authenticated staff replies"));
   assert.ok(enabled.includes("CURRENT-TURN DECISION SCOPE:"));
   assert.ok(enabled.includes("An earlier unanswered administrative or price question remains for staff"));
   assert.ok(!shadow.includes("CURRENT-TURN DECISION SCOPE:"));
   assert.equal(config.aiPricingIntentMode,"shadow");
   assert.equal(buildSystemPrompt({surface:"conversation",channel:"whatsapp",contactId:124}),shadow);
 }finally{config.aiPricingIntentMode=previous;}
});

test("server snapshots the exact contact mode before the provider request and reuses it for approval",()=>{
 const source=require("node:fs").readFileSync(require("node:path").join(__dirname,"../src/server.js"),"utf8");
 assert.match(source,/const aiPricingMode=resolveContactPricingMode\(\{\s*baseMode:clinicConfig\.aiPricingIntentMode,contactId:contact\.id,channel,/u);
 assert.ok(source.indexOf("const aiPricingMode=resolveContactPricingMode")<source.indexOf("const rawAiReply = await ai.getReply"));
 assert.match(source,/pricingIntentMode: aiPricingMode,/u);
 assert.match(source,/const aiPricingEnabled = aiPricingMode === "enabled"/u);
});
