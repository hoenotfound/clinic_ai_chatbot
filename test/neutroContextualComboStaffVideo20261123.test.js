"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {resolveContextualNeutroComboQuestion,
 resolveNeutroComboMediaPricingDecision}=require("../src/utils/neutroComboOfferReply");
const now=Date.now();
const t=(role,content,secondsAgo=0)=>({role,content,pricingCreatedAtMs:now-secondsAgo*1000});
const services=[{name:"3D 小颜术",duration:"约1小时30分钟"},
 {name:"9D 逆龄抗衰",duration:"约2小时"},
 {name:"3D + 9D 组合",duration:""}];
const promotion={name:"9D + 3D 组合限时优惠",
 linkedService:"3D + 9D 组合",sendOnPriceQuery:true,
 validFrom:"2000-01-01",validUntil:"2999-12-31",
 pricing:{currency:"MYR",offer:688},caption:"9D + 3D 组合 RM688"};
const text="这个一起做是多久，什么价格";
const history=[
 t("assistant","9D 是仪器类护理，3D 是徒手脸型护理",19*3600),
 {...t("assistant","[Verified STAFF message] 这里有介绍9D 哦",8*60),
  pricingStaffAuthored:true},
 t("user",text,5),
];
function check(h=history,extras={}){
 return resolveContextualNeutroComboQuestion({
  customerText:text,history:h,services,promotions:[promotion],
  language:"zh",now,...extras,
 });
}
test("natural combined-price/duration question uses verified RM688, not invented combined time",()=>{
 const result=check();
 assert.equal(result?.mode,"contextual");
 assert.equal(result?.treatment,"3D + 9D 组合");
 assert.match(result.reply,/RM688/);
 assert.match(result.reply,/总时长.*门店确认/u);
 assert.doesNotMatch(result.reply,/3小时30分钟|3\.5小时|3h30/);
 const media=resolveNeutroComboMediaPricingDecision({
  comboOfferDecision:result,promotions:[promotion],customerText:text,
  session:history,reply:result.reply,now,
 });
 assert.equal(media,null,"contextual reference cannot authorize a package image");
});
test("no ad-only, old, unverified or ambiguous reference can invent a combo quote",()=>{
 assert.equal(check([t("user",text,5)]),null);
 assert.equal(check([history[0],t("user",text,5)]),null);
 assert.equal(check([t("assistant","9D 和 3D 对比",25*3600),history[1],history[2]]),null);
 assert.equal(check(history.map((r,i)=>i===2?{...r,pricingCreatedAtMs:null}:r)),null);
 assert.equal(check(history,{promotions:[{...promotion,validUntil:"2020-01-01"}]}),null);
 assert.equal(check(history,{promotions:[promotion,{...promotion}]}),null);
 assert.equal(check(history,{customerText:"3D和骨盆一起做是多久，什么价格"}),null);
});
test("staff duplicate video caption blocks 2h only, without another Neon scan",()=>{
 const src=fs.readFileSync(require.resolve("../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 assert.match(src,/deliveredStaffVideoCaptionSql/);
 assert.match(src,/staff_caption\.whatsapp_message_id LIKE 'wamid\.%'/);
 assert.match(src,/staff_video_caption_sent/);
 assert.match(src,/if\(slot===2 && candidate\.staff_video_caption_sent===true\)/);
 assert.match(src,/await fail\("staff_already_sent_video_introduction"\)/);
 assert.doesNotMatch(src,/database\.query\(RECENT_STAFF_VIDEO_CAPTION_SQL/);
});
test("server uses verified contextual response only behind existing safety gates",()=>{
 const src=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 assert.match(src,/resolveContextualNeutroComboQuestion/);
 assert.match(src,/!flagged && !bookingReady/);
 assert.match(src,/comboMediaUnavailable/);
 assert.match(src,/\["direct","contextual"\]/);
});