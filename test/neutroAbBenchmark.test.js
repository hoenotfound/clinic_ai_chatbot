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
  assert.equal(cases.length,44);
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  assert.ok(cases.some(c=>c.surface==="follow_up"));
  const rows=await runBenchmark(original,candidate,cases);
  assert.equal(rows.length,cases.length);
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

test("follow-up cases use a synthetic final user request rather than assistant-ending Gemini contents",()=>{
  for(const scenario of cases.filter(c=>c.surface==="follow_up")){
    const req=requestFor(original,scenario);
    assert.equal(req.contents.length,1);
    assert.equal(req.contents[0].role,"user");
    assert.match(req.contents[0].parts[0].text,/CONVERSATION HISTORY:/);
    assert.match(req.contents[0].parts[0].text,/CUSTOMER:/);
  }
});
test("provider failure records sanitized status and never raw error body",async()=>{
  const rows=await runBenchmark(original,candidate,[cases[0]],async()=>{
    const err=Object.assign(Error("private secret or prompt"),{status:400});throw err;
  });
  assert.match(rows[0].A.error,/HTTP 400/);
  assert.doesNotMatch(renderReport(rows,true),/private secret/);
});
test("matched-pair totals visible even if a different pair failed",async()=>{
  let calls=0;
  const rows=await runBenchmark(original,candidate,cases.slice(0,2),async()=>{
    if(++calls===3) throw Object.assign(Error("secret"),{status:429});
    return {text:JSON.stringify({reply:"你好",outcome:"normal",priceQuery:false}),usageMetadata:{promptTokenCount:500,candidatesTokenCount:20}};
  });
  assert.equal(summarize(rows,"B").promptTokens,null);
  assert.match(renderReport(rows,true),/Matched pair input tokens/);
});

test("live benchmark distinguishes a verified raw location answer from one with contradictory extra text",()=>{
  const data={...original,branches:[{name:"Petaling Jaya (PJ)",address:"12 Jalan 19, Petaling Jaya, Selangor"}]};
  const scenario=cases.find(c=>c.id==="stage2-location-zh");
  for(const [reply,expected] of [["地址：12 Jalan 19, Petaling Jaya, Selangor 😊",true],["我们在 Puchong。地址：12 Jalan 19, Petaling Jaya, Selangor",false]]){
    const result=checksFor(data,scenario,JSON.stringify({reply,outcome:"normal",priceQuery:false}));
    assert.equal(result.checks.find(c=>c.field==="locationDraftStatus").pass,expected);
  }
});
