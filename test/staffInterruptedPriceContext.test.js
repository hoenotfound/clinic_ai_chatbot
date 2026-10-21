"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveStaffInterruptedPriceContext,
  formatStaffInterruptedPriceContext,
} = require("../src/utils/staffInterruptedPriceContext");

const NOW = Date.parse("2026-10-21T06:37:00Z");
const services = [{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const serviceAliases = [
  {alias:"9D",officialService:"9D 逆龄抗衰"},
  {alias:"3D",officialService:"3D 小颜术"},
  {alias:"骨盆",officialService:"骨盆调理"},
];
function turn(role, content, secondsBefore, staff = false) {
  const t = {role,content};
  Object.defineProperties(t,{
    pricingCreatedAtMs:{value:NOW-secondsBefore*1000,enumerable:false},
    pricingStaffAuthored:{value:staff,enumerable:false},
  });
  return t;
}
function example() {
  return [
    turn("user","Hi～我想了解 9D 逆龄抗衰",48),
    turn("assistant","9D 逆龄抗衰想改善脸部哪一块？",42),
    turn("assistant","这是9D逆龄抗衰完成一次后的案例",40),
    turn("assistant","我主要想改善紧致和下颚线",28,true),
    turn("user","我主要想改善紧致和下颚线",15),
    turn("assistant","了解，紧致和下颚线是9D逆龄抗衰常护理的方向。你什么时候方便？",9),
    turn("user","请问价格多少呢？",1),
  ];
}
function resolve(conversationHistory, customerText="请问价格多少呢？", now=NOW) {
  return resolveStaffInterruptedPriceContext({
    customerText,conversationHistory,services,serviceAliases,now,
  });
}

test("recognizes 9D for safe clarification after a staff-interrupted discussion without quoting money",()=>{
  const service=resolve(example());
  assert.equal(service,"9D 逆龄抗衰");
  const reply=formatStaffInterruptedPriceContext(service,"zh");
  assert.match(reply,/9D 逆龄抗衰/u);
  assert.match(reply,/门店核实/u);
  assert.doesNotMatch(reply,/RM|优惠价是|只需/u);
  assert.match(formatStaffInterruptedPriceContext(service,"en"),/9D 逆龄抗衰/u);
  assert.match(formatStaffInterruptedPriceContext(service,"ms"),/9D 逆龄抗衰/u);
});

test("cannot create pricing-context acknowledgement from assistant guesses or unrelated staff discussions",()=>{
  assert.equal(resolve(example().filter(x=>!x.pricingStaffAuthored)),null,"normal flow uses original verified pricing");
  const noCustomer=example();
  noCustomer[0]=turn("user","想了解脸部护理",48);
  assert.equal(resolve(noCustomer),null,"bot service guess is not customer selection");
  const staffChangesService=example();
  staffChangesService[3]=turn("assistant","其实我们现在讨论 3D 小颜术",28,true);
  assert.equal(resolve(staffChangesService),null);
  const customerChangesService=example();
  customerChangesService[4]=turn("user","我改聊 3D 小颜术",15);
  assert.equal(resolve(customerChangesService),null);
  const botAmbiguous=example();
  botAmbiguous[5]=turn("assistant","3D 和 9D 你想做哪个？",9);
  assert.equal(resolve(botAmbiguous),null);
});

test("cannot revive stale or mixed-intent price context",()=>{
  const stale=example();
  stale[0]=turn("user","Hi～我想了解 9D 逆龄抗衰",3600);
  assert.equal(resolve(stale),null);
  const missing=example();
  missing[0]={role:"user",content:"Hi～我想了解 9D 逆龄抗衰"};
  assert.equal(resolve(missing),null);
  const unrelated=example();
  unrelated[4]=turn("user","我想了解停车位置",15);
  assert.equal(resolve(unrelated),null);
  const cases=[
    "其他疗程价格多少？","全部疗程价格？","请问体验价格多少？",
    "请问9D价格多少？","请问 RM100 优惠券多少钱？",
  ];
  for(const text of cases){
    const turns=example();
    turns[6]=turn("user",text,1);
    assert.equal(resolve(turns,text),null,text);
  }
});

test("does not treat staff intervention as price authority",()=>{
  const selected=resolve(example());
  assert.equal(typeof selected,"string");
  assert.equal(selected,"9D 逆龄抗衰");
  const hold=formatStaffInterruptedPriceContext(selected,"zh");
  assert.equal(/\bRM\s*\d+/iu.test(hold),false);
});
