"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveCustomerEngagedPrice}=require("../src/utils/priceConversationRecovery");
const {resolveShadowPriceException}=require("../src/utils/shadowPriceException");
const {isDefiniteAppointmentCancellation,cancellationReviewAcknowledgement}=
 require("../src/utils/appointmentCancellationSafety");
const eligibility=require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const followup=require("../src/services/whatsappSecondaryFollowUpService");
const fs=require("node:fs"),path=require("node:path");
const now=Date.now();
const t=(role,content,msAgo,staff=false)=>({
 role,content,pricingCreatedAtMs:now-msAgo,pricingStaffAuthored:staff,
});
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const aliases=[{alias:"3D",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"}];
const promotions=[
 {name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
  validFrom:"2000-01-01",validUntil:"2999-12-31",imageUrl:"https://example.test/3d",
  pricing:{normal:888,offer:488,currency:"MYR"}},
 {name:"骨盆调理套餐",linkedService:"骨盆调理",sendOnPriceQuery:true,
  validFrom:"2000-01-01",validUntil:"2999-12-31",
  packages:[
   {name:"Package A",pricing:{normal:488,offer:388,currency:"MYR"},imageUrl:"https://example.test/a"},
   {name:"Package B",pricing:{normal:388,offer:288,currency:"MYR"},imageUrl:"https://example.test/b"},
  ]},
];
const opts=history=>({customerText:history.at(-1).content,conversationHistory:history,services,
 serviceAliases:aliases,promotions,now});

test("#8909: one-treatment 3D explanation and customer session question preserve price topic",()=>{
 const history=[
  t("user","Pm",118000),
  t("assistant","你是想了解3D脸型轮廓还是9D紧致提升？",117000),
  t("user","如何做的",116000),
  t("assistant","3D小颜术是徒手脸部护理，约1小时30分钟。",115000),
  t("assistant","这是3D小颜术的 Before & After",114000),
  t("user","一次就可以了吗",30000),
  t("user","多少钱",24000),
 ];
 assert.equal(resolveCustomerEngagedPrice(opts(history))?.name,"3D 小颜术");
 const price=resolveShadowPriceException(opts(history));
 assert.equal(price?.treatment,"3D 小颜术");
 assert.equal(price?.source,"customer_engaged_single_treatment");
 assert.ok(price.prices.some(x=>x.price==="RM488"));
});
test("#8856: an existing named pelvic enquiry can answer a later price-choice follow-up",()=>{
 const day=86400000;
 const history=[
  t("user","Hi～我对骨盆调理有兴趣",4*day),
  t("assistant","欢迎！想了解骨盆调理吗",4*day-5000),
  t("assistant","你比较想先看价钱，还是了解整个护理过程？",2*day),
  t("assistant","之前的护理如果想了解过程可以问我哦",day),
  t("user","看价钱",22000),
 ];
 assert.equal(resolveCustomerEngagedPrice(opts(history))?.name,"骨盆调理");
 const price=resolveShadowPriceException(opts(history));
 assert.equal(price?.treatment,"骨盆调理");
 assert.deepEqual(price?.prices?.map(x=>x.price).sort(),["RM288","RM388"]);
});
test("#8937: active pelvic enquiry stays scoped when customer requests weekend pricing",()=>{
 const history=[
  t("user","Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看",170000),
  t("assistant","想了解骨盆调理对吗？你困扰的是小腹凸还是体态不平衡？",168000),
  t("user","腰酸，长短腿",150000),
  t("assistant","我们建议中医师先帮你做1对1体态评估+体验",146000),
  t("user","weekends 我想了解价钱",120000),
 ];
 const p=resolveShadowPriceException(opts(history));
 assert.equal(p?.treatment,"骨盆调理");
 assert.deepEqual(p?.prices?.map(x=>x.price).sort(),["RM288","RM388"]);
});

test("Re-engagement never trusts a staff reply, treatment switch, clinical message or stale interest",()=>{
 const day=86400000;
 const baseline=[
  t("user","我对骨盆调理有兴趣",4*day),
  t("assistant","你想先看价钱，还是了解过程？",2*day),
  t("user","看价钱",1200),
 ];
 for(const history of [
  baseline.map(x=>x.content.includes("有兴趣")?{...x,pricingCreatedAtMs:now-8*day}:x),
  baseline.map(x=>x.role==="assistant"?{...x,pricingStaffAuthored:true}:x),
  [...baseline.slice(0,-1),t("user","不想做骨盆了，9D 多少钱",1000)],
  [...baseline.slice(0,-1),t("user","腰酸很痛，长短腿，我要看价格",1000)],
 ])assert.equal(resolveCustomerEngagedPrice(opts(history)),null);
});
test("#8889: a customer cancellation is never a recorded completed CRM action",()=>{
 assert.equal(isDefiniteAppointmentCancellation("哎呀，我这礼拜天突然有事，要取消预约。"),true);
 assert.equal(isDefiniteAppointmentCancellation("Please cancel my appointment"),true);
 for(const s of ["怎么取消预约？","如果我要取消预约怎么办","不用取消预约","Can I cancel my appointment?"])
  assert.equal(isDefiniteAppointmentCancellation(s),false,s);
 assert.match(cancellationReviewAcknowledgement("zh"),/还不能当作已经取消成功/);
 const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 assert.match(source,/isDefiniteAppointmentCancellation\(text\)/);
 assert.match(source,/clinicalAcknowledgement=aiReply/);
 assert.match(source,/setAiReviewAttention/);
});
test("all secondary contacts get new-inbound AI eligibility; not restricted to ads",async()=>{
 const env={
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-05T01:00:00Z",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-05T01:30:00Z",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-11-01T00:00:00Z",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"123",WHATSAPP_SECONDARY_WABA_ID:"456",
 };
 assert.equal(eligibility.secondaryAllContactReplyActivation(env),"2026-11-05T01:00:00.000Z");
 assert.equal(eligibility.secondaryAutomationActivation(env),"2026-11-05T01:30:00.000Z");
 let sql="";
 const eligible=await eligibility.isSecondaryAiReplyEligible(7245,{
  env,inboundMessageId:999,database:{query:async(q,args)=>{
   sql=q;assert.deepEqual(args,[7245,"123","456","2026-11-05T01:00:00.000Z",999]);
   return{rows:[{eligible:true}]};}},
 });
 assert.equal(eligible,true);
 assert.doesNotMatch(sql,/whatsapp_free_entry_referrals/);
 assert.match(sql,/inbound\.source_created_at/);
 const audience=eligibility.secondaryAutomationEligibleSql("c","$6","inbound","$7","$8");
 assert.match(audience,/all_contacts/);
 assert.match(audience,/ads_only/);
 assert.match(audience,/whatsapp_sender_message_context/);
 assert.match(audience,/source_created_at >=/);
});
test("#8926: 2h and 6h repeated follow-up videos have seven-day cooldown",()=>{
 for(const sql of [followup.CANDIDATES_SQL,followup.RECHECK_SQL]){
  assert.match(sql,/INTERVAL '7 days'/);
  assert.match(sql,/rule\.slot_hours IN \(2,6\)/);
  assert.match(sql,/same_slot\.status='accepted'/);
 }
});
