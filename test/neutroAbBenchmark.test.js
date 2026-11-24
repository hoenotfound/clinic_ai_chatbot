"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {getIndustryProfile} = require("../src/config/industryProfiles");
const config = require("../src/config/clinicConfig");
const {requestFor,checksFor,usageOf,runBenchmark,summarize,renderReport} = require("../scripts/neutro-ab");
const cases = require("../scripts/config-proposals/neutro-ab-cases.json");
const original = {...getIndustryProfile("tcm_clinic"),businessName:"Neutro Sense TCM Centre",
  messagingStyle:"Use concise replies. ".repeat(100)};
const candidate = {...original,messagingStyle:"Use concise replies."};

test("offline benchmark renders real request builder without provider calls or global config mutation",async()=>{
  const previous = structuredClone(config);
  assert.equal(cases.length,30);
  assert.equal(new Set(cases.map(c=>c.id)).size,30);
  assert.ok(cases.some(c=>c.surface==="follow_up"));
  const rows=await runBenchmark(original,candidate,cases);
  assert.equal(rows.length,30);
  assert.ok(summarize(rows,"B").promptChars < summarize(rows,"A").promptChars);
  assert.equal(summarize(rows,"A").promptTokens,null);
  assert.deepEqual(config,previous);
  assert.match(renderReport(rows,false),/no actual tokens/);
});
test("mocked live benchmark makes one application call per arm, tracks usage and checks decisions",async()=>{
  let calls=0;
  const selected=[cases[0],cases.find(c=>c.id==="followup-decline")];
  const rows=await runBenchmark(original,candidate,selected,async request=>{
    calls++;
    const follow=request.config.systemInstruction.includes("DECIDE THE ACTION:");
    return {text:JSON.stringify(follow?{action:"stop_sequence",reason:"declined",message:"",topic:"3D"}:
      {reply:"你好！",outcome:"normal",priceQuery:false}),
      usageMetadata:{promptTokenCount:1000,candidatesTokenCount:100,cachedContentTokenCount:50}};
  });
  assert.equal(calls,4);
  assert.equal(summarize(rows,"A").promptTokens,2000);
  assert.equal(summarize(rows,"B").valid,2);
  assert.equal(summarize(rows,"B").failedChecks,0);
  assert.ok(summarize(rows,"A").estimatedCostUsd>0);
});
test("invalid responses still retain billed usage and missing usage stays unknown",async()=>{
  const rows=await runBenchmark(original,candidate,[cases[0]],async()=>({
    text:"not JSON",usageMetadata:{promptTokenCount:2000,candidatesTokenCount:20}
  }));
  assert.equal(rows[0].A.valid,false);
  assert.equal(rows[0].A.usage.promptTokens,2000);
  assert.ok(summarize(rows,"A").estimatedCostUsd>0);
  assert.equal(usageOf({}).estimatedCostUsd,null);
  assert.equal(usageOf({}).cachedTokens,null);
});
test("report escapes HTML in replies and test history",()=>{
  const scenario={id:"unsafe <script>",note:"<script>alert(1)</script>",history:[{role:"user",content:"<img src=x>"}],A:{promptChars:10,reply:"<script>bad</script>"},B:{promptChars:8}};
  const html=renderReport([scenario],true);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x>"));
  assert.match(html,/&lt;script&gt;/);
});
