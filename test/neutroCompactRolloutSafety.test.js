"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {needsUnverifiedPulseDepthReview}=require("../src/utils/neutroUnverifiedPulseDepth");
const {guardUnconfirmedMediaPromise}=require("../src/utils/unconfirmedMediaPromiseGuard");
const config={businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",
  services:[{name:"脉冲波调理",description:"设备型号与作用深度没有经核实的技术资料，不能承诺作用深度或具体技术参数。"}]};
test("unverified depth questions escalate only on explicit matching service policy",()=>{
  for(const text of ["脉冲波可以深入几公分？","How deep can pulse wave penetrate?","Gelombang nadi boleh sampai berapa dalam?"])
    assert.equal(needsUnverifiedPulseDepthReview(config,text),true,text);
  for(const text of ["脉冲波有什么好处？","脉冲波一次可以小几cm？","9D可以深入几公分？","骨盆调理多少钱？"])
    assert.equal(needsUnverifiedPulseDepthReview(config,text),false,text);
  assert.equal(needsUnverifiedPulseDepthReview({...config,businessName:"Other clinic"},"脉冲波可以深入几公分？"),false);
  assert.equal(needsUnverifiedPulseDepthReview({...config,services:[{name:"脉冲波调理",description:"经核实的设备资料"}]},"脉冲波可以深入几公分？"),false);
});
test("actual media promise from live report is removed by existing delivery guard",()=>{
  const original="3D小颜术目前有 First Trial 体验优惠哦 😊。我把当前的优惠详情发给你参考～。你主要是想改善脸型轮廓吗？";
  const guarded=guardUnconfirmedMediaPromise(original,"zh");
  assert.equal(guarded.changed,true);
  assert.match(guarded.reply,/First Trial/);
  assert.doesNotMatch(guarded.reply,/发给你/);
});
test("final server review gate precedes optional media and clears rejected preferences",()=>{
  const source=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
  const guard=source.indexOf("if ((!flagged || reviewRequired) && needsUnverifiedPulseDepthReview");
  const earlyReturn=source.indexOf("if (flagged && reviewRequired) {",guard);
  const media=source.indexOf("const allowOptionalMediaSend",earlyReturn);
  assert.ok(guard>=0&&earlyReturn>guard&&media>earlyReturn);
  const block=source.slice(guard,earlyReturn);
  assert.match(block,/reviewType = "clinical"/);
  for(const key of ["serviceQuery","priceQuery","packageQuery","bookingReady"]) assert.match(block,new RegExp(key+" = false"));
  assert.match(source,/details = \{\.\.\.details, appointmentPreference:null\}/);
});
