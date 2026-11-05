"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {improveRepeatedPriceClarification}=require("../src/utils/repeatedPriceClarification");
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"3D + 9D 组合"},{name:"骨盆调理"}];
const aliases=[{alias:"3d小颜术",officialService:"3D 小颜术"},
{alias:"9d紧致提拉",officialService:"9D 逆龄抗衰"},
{alias:"3d",officialService:"3D 小颜术"},
{alias:"9d",officialService:"9D 逆龄抗衰"}];
const generic="请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊";
const run=(customerText,conversationHistory,reply=generic)=>
 improveRepeatedPriceClarification({customerText,conversationHistory,reply,
 services,serviceAliases:aliases,language:"zh"});
test("Nov 1 contact 8858: do not repeat what treatment after customer named 3D",()=>{
 const history=[
 {role:"user",content:"我想了解3D小颜术"},
 {role:"assistant",content:generic},
 {role:"user",content:"3d小颜术"},
 {role:"assistant",content:"这项疗程的最新价格需要由门店帮你确认"},
 {role:"user",content:"一次多少钱"},
 ];
 const answer=run("一次多少钱",history);
 assert.equal(answer.changed,true);
 assert.match(answer.reply,/3D 小颜术/);
 assert.doesNotMatch(answer.reply,/\bRM\s*\d+/iu);
});
test("acknowledge two separate treatments without inventing either price",()=>{
 const history=[{role:"user",content:"两个的价钱"},
 {role:"assistant",content:generic},
 {role:"user",content:"3d小颜术和9d紧致提拉"}];
 const answer=run("3d小颜术和9d紧致提拉",history);
 assert.equal(answer.changed,true);
 assert.match(answer.reply,/3D 小颜术和9D 逆龄抗衰/);
 assert.doesNotMatch(answer.reply,/RM488|RM1288/);
});
test("do not change first clarification, staff-owned or unrelated replies",()=>{
 assert.equal(run("3D多少钱",[{role:"user",content:"3D多少钱"}]).changed,false);
 assert.equal(run("3D多少钱",[{role:"assistant",content:generic,pricingStaffAuthored:true}]).changed,false);
 assert.equal(run("3D多少钱",[{role:"assistant",content:generic}],"请稍等我们的团队").changed,false);
 assert.equal(run("价钱",[{role:"assistant",content:generic}]).changed,false);
});

test("4 Nov treatment continuity: current 3D explanation is not lost at the first price follow-up",()=>{
 const history=[
  {role:"user",content:"Pm"},
  {role:"assistant",content:"3D 小颜术主要是徒手做的脸型和轮廓护理哦"},
  {role:"user",content:"如何做的"},
  {role:"assistant",content:"3D 小颜术会先看你的面部比例，然后做徒手护理"},
  {role:"user",content:"多少钱"},
 ];
 const response=run("多少钱",history);
 assert.equal(response.changed,true);
 assert.match(response.reply,/3D 小颜术/);
 assert.doesNotMatch(response.reply,/RM\d+/u);
});
test("first bare price and mixed treatment threads still fail closed",()=>{
 assert.equal(run("多少钱",[{role:"user",content:"多少钱"}]).changed,false);
 const both=[
  {role:"user",content:"想了解3D和9D"},
  {role:"assistant",content:"3D和9D都可以选择"},
  {role:"user",content:"一次多少钱"},
 ];
 assert.equal(run("一次多少钱",both).changed,false);
});

test("generic clinic first-clarification behaviour remains unchanged",()=>{
 const history=[
  {role:"user",content:"想了解3D小颜术"},
  {role:"assistant",content:"3D 小颜术是我们的面部护理项目"},
  {role:"user",content:"多少钱"},
 ];
 const genericClinic=improveRepeatedPriceClarification({
  customerText:"多少钱",reply:generic,conversationHistory:history,
  services,serviceAliases:aliases,language:"zh",
 });
 assert.equal(genericClinic.changed,false);
});
