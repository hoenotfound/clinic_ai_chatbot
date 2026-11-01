"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveNeutroComboOfferReply } = require("../src/utils/neutroComboOfferReply");

const now=Date.now();
const turn=(role,content,s=0)=>({role,content,pricingCreatedAtMs:now-s*1000});
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"3D + 9D 组合"}];
const serviceAliases=[
 {alias:"3D",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"},
 {alias:"3D+9D",officialService:"3D + 9D 组合"},
];
const combo={name:"9D + 3D 组合限时优惠",linkedService:"3D + 9D 组合",
 sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
 pricing:{currency:"MYR",offer:688},
 caption:"9D + 3D 组合限时优惠: RM688",
 followUpMessage:"组合体验价只需 RM688，另免费送你 1 小时经络穴位按摩"};
const promotions=[combo];
function check(text,session,extra={}){
 return resolveNeutroComboOfferReply({customerText:text,session,services,
   serviceAliases,promotions,now,language:"zh",...extra});
}

test("customer naming both therapies receives a combo suggestion only after verified individual quote",()=>{
 const session=[turn("user","9d",240),turn("assistant","9D RM488",235),
   turn("user","3d的多少钱？",180)];
 assert.equal(check("3d的多少钱？",session),null);
 const result=check("3d的多少钱？",session,{verifiedIndividualQuote:true});
 assert.equal(result?.mode,"suggestion");
 assert.match(result.reply,/RM688/u);
});
test("explicit joint-price question quotes the verified combo",()=>{
 for(const text of ["3D+9D组合多少钱？","3D和9D一起做多少钱？"]){
   const result=check(text,[turn("user",text,60)]);
   assert.equal(result?.mode,"direct");
   assert.match(result.reply,/RM688/u);
 }
});
test("general interest, unrelated price and a rejected combo do not trigger pricing",()=>{
 for(const text of ["我想了解3D和9D","9d多少钱","3D 和 9D 分别多少钱？不要组合"]){
   const result=check(text,[turn("user",text,60)],{verifiedIndividualQuote:true});
   assert.equal(result,null,text);
 }
});
test("expired, contradictory or duplicated campaigns fail closed",()=>{
 const text="3D+9D组合多少钱？",session=[turn("user",text,60)];
 assert.equal(check(text,session,{promotions:[{...combo,validUntil:"2020-01-01"}]}),null);
 assert.equal(check(text,session,{promotions:[{...combo,pricing:{currency:"MYR",offer:999}}]}),null);
 assert.equal(check(text,session,{promotions:[combo,{...combo}]}),null);
});
test("unverified timestamps and staff turns do not authorize an offer",()=>{
 const text="3d多少钱";
 const session=[turn("user","9d",220),turn("assistant","9D RM488",200),turn("user",text,100)];
 const missing=[...session];missing[0]={...missing[0],pricingCreatedAtMs:null};
 assert.equal(check(text,missing,{verifiedIndividualQuote:true}),null);
 const staff=[...session];staff[1]={...staff[1],pricingStaffAuthored:true};
 assert.equal(check(text,staff,{verifiedIndividualQuote:true}),null);
});
test("English and Malay messages are localized",()=>{
 const text="3D+9D combo price?";
 assert.match(check(text,[turn("user",text,100)],{language:"en"})?.reply||"",/RM688/u);
 assert.match(check(text,[turn("user",text,100)],{language:"ms"})?.reply||"",/RM688/u);
});
