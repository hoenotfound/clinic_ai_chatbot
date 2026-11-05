"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveNeutroFacialConcernPrice}=require("../src/utils/neutroFacialConcernPrice");
const {resolveShadowPriceException}=require("../src/utils/shadowPriceException");
const {resolveApprovedPricingAssessment}=require("../src/utils/approvedPricingDecision");

const now=Date.now();
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const serviceAliases=[
 {alias:"3D",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"},
];
const promotions=[{
 name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
 validFrom:"2000-01-01",validUntil:"2999-12-31",imageUrl:"https://example.test/3d",
 pricing:{currency:"MYR",normal:888,offer:488},
 followUpMessage:"3D 小颜术 First Trial 现在只需 RM488（原价 RM888）",
}];
const t=(role,content,age,staff=false)=>({role,content,pricingStaffAuthored:staff,pricingCreatedAtMs:now-age});
const turns=()=>[
 t("user","可以知道徒手脸型护理价钱多少",8*60*60*1000),
 t("assistant","请问你想了解哪一项疗程的价格呢？",8*60*60*1000-1200),
 t("assistant","想了解哪一种小颜护理呢？3D 主要针对脸型轮廓，9D 侧重紧致提升",90*60*1000),
 t("user","脸型",70_000),
 t("assistant","目前 First Trial 有限时优惠活动，护理大约 1小时30分钟",65_000),
 t("assistant","这个是顾客完成一次【3D小颜术】后的 Before & After",62_000),
 t("user","可以知道现在trial price",60_000),
];
const args=(override={})=>({
 customerText:"可以知道现在trial price",conversationHistory:turns(),
 services,serviceAliases,promotions,metaAdContext:null,now,
 ...override,
});
test("Nov 5 #685: actual facial concern selection authorizes only configured 3D First Trial",()=>{
 const q=args();
 const selected=resolveNeutroFacialConcernPrice({customerText:q.customerText,session:q.conversationHistory,
  services,serviceAliases,now});
 assert.equal(selected?.name,"3D 小颜术");
 const price=resolveShadowPriceException(q);
 assert.equal(price?.source,"customer_facial_concern_selection");
 assert.equal(price?.treatment,"3D 小颜术");
 assert.deepEqual(price?.prices?.map(x=>x.price),["RM488"]);
 const approved=resolveApprovedPricingAssessment({
   mode:"shadow",shadowException:price,customerText:q.customerText,
   conversationHistory:q.conversationHistory,services,serviceAliases,
   resultMedia:[],now,
 });
 assert.equal(approved.reason,"approved");
 assert.equal(approved.decision?.treatment,"3D 小颜术");
});
test("Nov 5 #685: no bot mapping, stale discussion, staff, or conflicting service never quotes",()=>{
 for(const conversationHistory of [
  turns().filter(x=>!x.content.includes("3D 主要")),
  turns().map(x=>x.content==="脸型"?{...x,content:"紧致提升"}:x),
  turns().map(x=>x.content==="脸型"?{...x,content:"3D 9D 都要"}:x),
  turns().map(x=>x.content.includes("Before & After")?{...x,pricingStaffAuthored:true}:x),
  turns().map(x=>x.content==="脸型"?{...x,pricingCreatedAtMs:now-4*60*60*1000}:x),
  turns().map(x=>x.content.includes("Before & After")?{...x,content:"9D 逆龄抗衰 Before & After"}:x),
 ]){
  assert.equal(resolveNeutroFacialConcernPrice({customerText:"可以知道现在trial price",session:conversationHistory,
   services,serviceAliases,now}),null);
 }
 assert.equal(resolveNeutroFacialConcernPrice({customerText:"second session trial price",session:turns().map(t=>t.content==="可以知道现在trial price"?{...t,content:"second session trial price"}:t),
 services,serviceAliases,now}),null);
});
