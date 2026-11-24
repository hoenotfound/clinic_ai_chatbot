"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveAiPricingDecision,resolveModelLedPricingDecision,shouldApplyModelLedPricing,shouldBlockRejectedModelPricing,hasConflictingStaffPrice}=require("../src/utils/aiPricingIntentDecision");
const {resolveApprovedPricingAssessment}=require("../src/utils/approvedPricingDecision");
const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
const {resolvePricePromotionForReply}=require("../src/utils/pricePromotionTrigger");

const now=Date.now();
const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"骨盆调理"}];
const serviceAliases=[{alias:"3D",officialService:"3D 小颜术"},{alias:"9D",officialService:"9D 逆龄抗衰"},{alias:"Pelvic Care",officialService:"骨盆调理"},{alias:"骨盆调整",officialService:"骨盆调理"}];
const promo=(name,price)=>({name:name+" First Trial",linkedService:name,sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",imageUrl:"https://example.test/"+price,caption:"First Trial RM"+price,pricing:{currency:"MYR",offer:price}});
const promotions=[promo("3D 小颜术",388),promo("9D 逆龄抗衰",488),
 {...promo("骨盆调理",388),packages:[
  {name:"Package A",imageUrl:"https://example.test/a",caption:"First Trial RM388",pricing:{currency:"MYR",offer:388}},
  {name:"Package B",imageUrl:"https://example.test/b",caption:"First Trial RM268",pricing:{currency:"MYR",offer:268}},
 ]}];
const turn=(role,content,ms)=>({role,content,pricingCreatedAtMs:now-ms});
function args(current="What would I be paying?",name="3D 小颜术",extra={}){
 return {now,services,serviceAliases,promotions,customerText:current,
  conversationHistory:[turn("user",name,2000),turn("assistant",name+" is available.",1000),turn("user",current,0)],
  modelIntent:{structured:true,outcome:"normal",priceQuery:true,packageQuery:false,treatment:name,pricingStage:null,promotionOption:null},...extra};
}
test("reuse actual model interpretation of novel phrasing without a positive price keyword",async()=>{
 for(const [question,name,expected] of [
  ["What would I be paying?","3D 小颜术",["RM388"]],
  ["我需要准备多少预算才够？","骨盆调理",["RM388","RM268"]],
  ["Berapa perlu saya sediakan?","9D 逆龄抗衰",["RM488"]],
 ]){
  const a=args(question,name);
  const d=resolveModelLedPricingDecision(a);
  assert.equal(d?.source,"model_led_customer_context",question);
  assert.equal(d?.treatment,name);
  assert.deepEqual(d.prices.map(p=>p.price),expected);
  const approved=resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:d});
  assert.equal(approved.reason,"approved");
  const r=ensureVerifiedPriceReply({...a,reply:"Let me check for you.",treatment:name,
   clarifiedPriceService:name,pricingDecision:approved.decision,priceOnlyResponse:true,priceRequested:true,language:"en"});
  for(const amount of expected)assert.ok(r.reply.includes(amount),r.reply);
  const media=await resolvePricePromotionForReply({...a,aiPricingEnabled:true,pricingDecision:approved.decision,
   treatment:name,verifiedServiceFromText:name,textSendSucceeded:true,contactId:1,
   wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now)});
  assert.equal(media?.packages?.length,expected.length);
  const blocked=await resolvePricePromotionForReply({...a,aiPricingEnabled:true,pricingDecision:approved.decision,
   treatment:name,verifiedServiceFromText:name,textSendSucceeded:true,contactId:1,
   wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>true,now:new Date(now)});
  assert.equal(blocked,null);
 }
});
test("grounded direct treatment changes take precedence; model-only treatment cannot authorize",()=>{
 const a=args("What would I be paying for 9D?","9D 逆龄抗衰");
 a.conversationHistory=[turn("user","3D 小颜术",2000),turn("assistant","3D 小颜术 is available",1000),turn("user",a.customerText,0)];
 assert.equal(resolveModelLedPricingDecision(a)?.treatment,"9D 逆龄抗衰");
 const b=args();b.conversationHistory=[turn("user","Hello",2000),turn("assistant","3D 小颜术",1000),turn("user",b.customerText,0)];
 assert.equal(resolveModelLedPricingDecision(b),null);
});
test("known non-price and safety cases, false model metadata, conflicting context and stale history fail closed",()=>{
 for(const current of ["Hi","Thanks","一次有效吗？","3D 小颜术","How long does it take?","不要报价","How much is the deposit?","太贵了","Where is your branch?","我有乳腺结节","可以跟进我，有优惠也发我看看"]){
  assert.equal(resolveModelLedPricingDecision(args(current)),null,current);
 }
 for(const intent of [{priceQuery:false},{structured:false},{outcome:"review_required"},{outcome:"booking_ready"},{treatment:"invented"},{pricingStage:"subsequent_session"},{promotionOption:"Package C"}]){
  const a=args();a.modelIntent={...a.modelIntent,...intent};
  assert.equal(resolveModelLedPricingDecision(a),null,JSON.stringify(intent));
 }
 for(const kind of ["staff","multiple","stale","missing","clinical"]){
  const a=args();
  if(kind==="staff")a.conversationHistory[1].pricingStaffAuthored=true;
  if(kind==="multiple")a.conversationHistory[1].content="3D 小颜术 or 9D 逆龄抗衰";
  if(kind==="stale")a.conversationHistory[0].pricingCreatedAtMs=now-25*3600000;
  if(kind==="missing")delete a.conversationHistory[0].pricingCreatedAtMs;
  if(kind==="clinical")a.conversationHistory.unshift(turn("user","我有乳腺结节",3000));
  assert.equal(resolveModelLedPricingDecision(a),null,kind);
 }
 assert.equal(resolveModelLedPricingDecision(args(undefined,undefined,{promotions:[]})),null);
});
test("specific configured package remains independently checked; package enquiry setting remains authoritative",()=>{
 const a=args("What would I be paying for Package B?","骨盆调理");
 a.modelIntent.promotionOption="Package B";
 assert.deepEqual(resolveModelLedPricingDecision(a)?.prices.map(p=>p.price),["RM268"]);
 a.modelIntent.promotionOption="Package A";
 assert.equal(resolveModelLedPricingDecision(a),null);
 const b=args("What are the options?","骨盆调理");b.modelIntent.priceQuery=false;b.modelIntent.packageQuery=true;
 assert.equal(resolveModelLedPricingDecision(b),null);
 assert.equal(resolveModelLedPricingDecision({...b,allowOfferEnquiries:true})?.type,"package_options");
});
test("shadow and off never apply semantic decision; enabled prefers approved model interpretation",()=>{
 const d=resolveModelLedPricingDecision(args());assert.ok(d);
 const base={mode:"enabled",legacyApproval:{decision:null},semanticApproval:{decision:d}};
 assert.equal(shouldApplyModelLedPricing(base),true);
 assert.equal(shouldApplyModelLedPricing({...base,legacyCandidate:d,legacyApproval:{decision:d}}),true);
 for(const override of [{mode:"off"},{mode:"shadow"},{legacyCandidate:d},{hasSpecialDecision:true},{semanticApproval:{decision:null}}]){
  assert.equal(shouldApplyModelLedPricing({...base,...override}),false,JSON.stringify(override));
 }
 for(const override of [{flagged:true},{bookingReady:true},{marketingStopQuestion:true},{keywordReason:"review"}]){
  assert.equal(resolveApprovedPricingAssessment({...args(),mode:"enabled",aiDecision:d,...override}).decision,null);
 }
});

test("natural multi-turn treatment context, verified staff assistance, and changed treatment",()=>{
 const a=args("那我要准备多少预算呢？","骨盆调理");
 a.conversationHistory=[
  turn("user","骨盆调理",9000),turn("assistant","骨盆调理可以先了解。",8000),
  turn("user","一次有效吗？",7000),turn("assistant","每个人情况不同哦。",6000),
  turn("user","那需要多久？",5000),turn("assistant","我们可以先介绍护理。",4000),
  turn("user",a.customerText,0)
 ];
 assert.deepEqual(resolveModelLedPricingDecision(a)?.prices.map(p=>p.price),["RM388","RM268"]);
 const delivered={...turn("assistant","[Verified STAFF message] 骨盆调理 Before & After",3000),pricingStaffAuthored:true,pricingDeliveredStaffImage:true};
 a.conversationHistory.splice(-1,0,delivered);
 assert.equal(resolveModelLedPricingDecision(a)?.treatment,"骨盆调理");
 a.conversationHistory[a.conversationHistory.length-2]={...delivered,pricingDeliveredStaffImage:false,pricingVerifiedStaffText:true,content:"[Verified STAFF message] 骨盆调理是本店护理项目。"};
 assert.equal(resolveModelLedPricingDecision(a)?.treatment,"骨盆调理");
 a.conversationHistory[a.conversationHistory.length-2].content="[Verified STAFF message] 骨盆调理 RM999";
 assert.equal(resolveModelLedPricingDecision(a),null);
 a.conversationHistory[a.conversationHistory.length-2]={...delivered,pricingDeliveredStaffImage:false};
 assert.equal(resolveModelLedPricingDecision(a),null);
 a.conversationHistory.splice(-1,0,turn("user","9D 逆龄抗衰",1000));
 assert.equal(resolveModelLedPricingDecision(a),null);
});
test("indirect package reference requires a grounded menu with matching configured package amounts",()=>{
 const a=args("比较便宜的那个多少钱？","骨盆调理");
 a.modelIntent.promotionOption="Package B";
 a.conversationHistory[1].content="骨盆调理\nPackage A: RM388\nPackage B: RM268";
 assert.deepEqual(resolveModelLedPricingDecision(a)?.prices.map(p=>p.price),["RM268"]);
 a.modelIntent.promotionOption="Package A";
 assert.equal(resolveModelLedPricingDecision(a),null);
 a.modelIntent.promotionOption="Package B";
 a.conversationHistory[1].content="骨盆调理\nPackage A: RM268\nPackage B: RM388";
 assert.equal(resolveModelLedPricingDecision(a),null);
 a.conversationHistory[1].content="骨盆调理有两种选择";
 assert.equal(resolveModelLedPricingDecision(a),null);
});
test("ordinary service questions and future consent with honest model intent do not produce a price",()=>{
 for(const current of ["一次有效吗？","这个适合我吗？","How many sessions?","以后有优惠发我看看","Terima kasih"]){
  const a=args(current);
  a.modelIntent.priceQuery=false;
  a.modelIntent.packageQuery=false;
  assert.equal(resolveModelLedPricingDecision(a),null,current);
 }
});
test("model-led graphic must match the configured amounts after price changes",async()=>{
 const a=args(),d=resolveModelLedPricingDecision(a);
 assert.ok(d);
 const changed=promotions.map(p=>p.linkedService===d.treatment?
   {...p,caption:"First Trial RM488",pricing:{currency:"MYR",offer:488}}:p);
 const media=await resolvePricePromotionForReply({...a,promotions:changed,
  aiPricingEnabled:true,pricingDecision:d,treatment:d.treatment,
  verifiedServiceFromText:d.treatment,textSendSucceeded:true,contactId:1,
  wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
  now:new Date(now)});
 assert.equal(media,null);
});

test("staff quote conflict survives fallback and ignores a separately named unrelated service",()=>{
 const a=args();
 const staff={...turn("assistant","[Verified STAFF message] 3D 小颜术 RM999",500),
  pricingStaffAuthored:true,pricingVerifiedStaffText:true};
 a.conversationHistory.splice(-1,0,staff);
 const input={...a,treatment:"3D 小颜术"};
 assert.equal(hasConflictingStaffPrice(input),true);
 staff.content="[Verified STAFF message] 3D 小颜术 RM388";
 assert.equal(hasConflictingStaffPrice(input),false);
 staff.content="[Verified STAFF message] 9D 逆龄抗衰 RM999";
 assert.equal(hasConflictingStaffPrice(input),false);
});
test("simple verified natural quote survives formatting; extra or wrong commercial claims do not",()=>{
 const a=args(),d=resolveModelLedPricingDecision(a);
 assert.ok(d);
 const input={...a,treatment:d.treatment,pricingDecision:d,priceRequested:true,language:"zh"};
 const good="亲爱的，3D 小颜术目前首次体验只需 RM388 哦 😊";
 assert.equal(ensureVerifiedPriceReply({...input,reply:good}).reply,good);
 for(const reply of ["3D 小颜术首次体验只需 RM999","3D 小颜术首次体验只需 RM388，保证一次见效","3D 小颜术首次体验 RM388，再送 RM100 优惠券"]){
  const result=ensureVerifiedPriceReply({...input,reply});
  assert.equal(result.restored,true,reply);
  assert.ok(result.reply.includes("RM388"),result.reply);
  assert.ok(!result.reply.includes("RM999")&&!result.reply.includes("保证一次见效")&&!result.reply.includes("RM100"),result.reply);
 }
});
test("server uses accepted language result and both approved price intent types in quiet hours",()=>{
 const source=require("node:fs").readFileSync(require("node:path").join(__dirname,"../src/server.js"),"utf8");
 assert.match(source,/modelPricingIntent = languageCheckedReply\.languageCorrectionFailed\s*\? null/u);
 assert.match(source,/solicitedPricing:Boolean\(secondaryAiConversation &&\s*\["price","package_options"\]\.includes\(approvedPricingDecision\?\.type\)/u);
});

test("rejected model package scope cannot widen a legacy quote",()=>{
 const a=args("比较便宜的那个多少钱？","骨盆调理");
 a.modelIntent.promotionOption="Package B";
 const legacy={decision:{treatment:"骨盆调理",prices:[{name:"Package A",price:"RM388"},{name:"Package B",price:"RM268"}]}};
 const base={mode:"enabled",modelIntent:a.modelIntent,semanticCandidate:null,semanticApproval:{decision:null},
  legacyApproval:legacy,customerText:a.customerText,promotions};
 assert.equal(shouldBlockRejectedModelPricing(base),true);
 assert.equal(shouldBlockRejectedModelPricing({...base,mode:"shadow"}),false);
 assert.equal(shouldBlockRejectedModelPricing({...base,hasSpecialDecision:true}),false);
 assert.equal(shouldBlockRejectedModelPricing({...base,customerText:"Package B 多少钱？",
  legacyApproval:{decision:{treatment:"骨盆调理",prices:[{name:"Package B",price:"RM268"}]}}}),false);
 assert.equal(shouldBlockRejectedModelPricing({...base,semanticCandidate:{treatment:"骨盆调理"}}),true);
});
test("verified staff price accepts correctly associated original and voucher but rejects wrong payable price",()=>{
 const {staffQuoteMatchesConfiguredPrice}=require("../src/utils/verifiedPriceReply");
 const structured={currency:"MYR",normal:488,offer:388},verified={name:"Package A",price:"RM388",afterVoucher:true};
 const good="Package A\n原价 RM488\nRM100 优惠券\n优惠后仅需 RM388";
 assert.equal(staffQuoteMatchesConfiguredPrice(good,structured,verified),true);
 for(const bad of [good.replace("仅需 RM388","仅需 RM399"),good.replace("原价 RM488","原价 RM588"),good.replace("RM100 优惠券","RM200 优惠券")])
   assert.equal(staffQuoteMatchesConfiguredPrice(bad,structured,verified),false,bad);
});
test("simple correct package menu preserves model wording but swapped amounts are rejected",()=>{
 const {preserveVerifiedModelQuote}=require("../src/utils/verifiedPriceReply");
 const good="亲爱的，骨盆调理目前有两个配套哦 😊\nPackage A：RM388\nPackage B：RM268";
 const prices=[{name:"Package A",price:"RM388"},{name:"Package B",price:"RM268"}];
 assert.equal(preserveVerifiedModelQuote({reply:good,treatment:"骨盆调理",prices,firstTrialQuote:false}),good);
 assert.equal(preserveVerifiedModelQuote({reply:good.replace("RM388","RM268").replace(/RM268$/,"RM388"),treatment:"骨盆调理",prices,firstTrialQuote:false}),null);
 assert.equal(preserveVerifiedModelQuote({reply:good,treatment:"骨盆调理",prices:[{...prices[0],afterVoucher:true},prices[1]],firstTrialQuote:false}),null);
});

test("live A/B: exact negated treatment correction approves only the newly requested service",async()=>{
 const a=args("不是3D，我想了解9D的价钱","9D 逆龄抗衰");
 a.conversationHistory=[turn("user","3D 小颜术",2000),turn("assistant","3D 小颜术 is available",1000),turn("user",a.customerText,0)];
 const d=resolveModelLedPricingDecision(a);
 assert.equal(d?.treatment,"9D 逆龄抗衰");
 assert.deepEqual(d.prices.map(p=>p.price),["RM488"]);
 const approved=resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:d});
 assert.equal(approved.reason,"approved");
 const media=await resolvePricePromotionForReply({...a,aiPricingEnabled:true,pricingDecision:approved.decision,
  treatment:d.treatment,verifiedServiceFromText:d.treatment,textSendSucceeded:true,contactId:1,
  wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now)});
 assert.equal(media?.packages?.length,1);
 for(const current of ["不是3D，我想了解3D的价钱","3D和9D的价钱","不是3D，我想了解9D的价钱，停止联系我"]){
  const b=args(current,"9D 逆龄抗衰");
  assert.equal(resolveModelLedPricingDecision(b),null,current);
 }
 const wrong={...a,modelIntent:{...a.modelIntent,treatment:"3D 小颜术"}};
 assert.equal(resolveModelLedPricingDecision(wrong),null);
 const contradictory=args("不要3D，3D多少钱？","3D 小颜术");
 assert.equal(resolveModelLedPricingDecision(contradictory),null);
 assert.equal(resolveAiPricingDecision({...contradictory,priceQuery:true,treatment:"3D 小颜术"}),null);
});
test("live A/B: future notification alone cannot become a quote in either resolver or send boundary",async()=>{
 const {hasFuturePromotionPermissionWithoutPrice}=require("../src/utils/customerEnquiryEvidence");
 const current="Kalau ada promosi nanti, beritahu saya ya";
 const a=args(current,"骨盆调理",{allowOfferEnquiries:true});
 assert.equal(hasFuturePromotionPermissionWithoutPrice(current),true);
 assert.equal(hasFuturePromotionPermissionWithoutPrice(current+". Berapa harga Pelvic Care?"),false);
 for(const flags of [{priceQuery:false,packageQuery:false},{priceQuery:true,packageQuery:true}]){
  assert.equal(resolveAiPricingDecision({...a,...flags,treatment:"骨盆调理"}),null);
  assert.equal(resolveModelLedPricingDecision({...a,modelIntent:{...a.modelIntent,...flags}}),null);
 }
 const forged=resolveModelLedPricingDecision(args("What would I be paying?","骨盆调理"));
 assert.ok(forged);
 assert.equal(resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:forged}).reason,"future_offer_permission_only");
 assert.equal(resolveApprovedPricingAssessment({...a,mode:"shadow",shadowException:forged}).reason,"future_offer_permission_only");
 for(const enabled of [true,false]){
  let reason;
  const media=await resolvePricePromotionForReply({...a,aiPricingEnabled:enabled,pricingDecision:forged,
   treatment:forged.treatment,priceQuery:true,packageQuery:true,verifiedServiceFromText:forged.treatment,
   textSendSucceeded:true,contactId:1,wasPromoRecentlySent:async()=>false,
   hasUnconfirmedMediaDelivery:async()=>false,onSkip:r=>reason=r,now:new Date(now)});
  assert.equal(media,null);
  assert.equal(reason,"future_offer_permission_only");
 }
});
test("live A/B: approved narrower package beats broad legacy quote and selects only matching artwork",async()=>{
 const a=args("比较便宜的那个多少钱？","骨盆调理");
 a.modelIntent.promotionOption="Package B";
 a.conversationHistory[1].content="骨盆调理\nPackage A: RM388\nPackage B: RM268";
 const semantic=resolveModelLedPricingDecision(a);
 const legacy={...semantic,prices:[{name:"Package A",price:"RM388"},{name:"Package B",price:"RM268"}]};
 const legacyApproval=resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:legacy});
 const semanticApproval=resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:semantic});
 assert.ok(legacyApproval.decision);
 assert.ok(semanticApproval.decision);
 assert.equal(shouldApplyModelLedPricing({mode:"enabled",legacyCandidate:legacy,legacyApproval,semanticApproval}),true);
 assert.equal(shouldApplyModelLedPricing({mode:"enabled",legacyCandidate:legacy,legacyApproval,semanticApproval,hasSpecialDecision:true}),false);
 const decision=semanticApproval.decision;
 const formatted=ensureVerifiedPriceReply({...a,reply:"比较优惠的是 Package B，First Trial RM268 😊",
  treatment:decision.treatment,pricingDecision:decision,priceRequested:true,priceOnlyResponse:true,language:"zh"});
 assert.ok(formatted.reply.includes("RM268"));
 assert.ok(!formatted.reply.includes("RM388"));
 const media=await resolvePricePromotionForReply({...a,aiPricingEnabled:true,pricingDecision:decision,
  treatment:decision.treatment,verifiedServiceFromText:decision.treatment,textSendSucceeded:true,contactId:1,
  wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now)});
 assert.deepEqual(media?.packages?.map(p=>p.name),["Package B"]);
});


test("live WhatsApp: delivered configured package graphics do not hide the actual priced menu",async()=>{
 const a=args("比较便宜的那个多少钱？","骨盆调理");
 a.services=[...a.services,{name:"子宫调理"}];
 a.serviceAliases=[...a.serviceAliases,{alias:"骨盆",officialService:"骨盆调理"},{alias:"子宫",officialService:"子宫调理"}];
 a.modelIntent.promotionOption="Package B";
 const menu={...turn("assistant","骨盆调理目前的配套价格是：\n• Package A（尊享护理配套｜2小时30分钟）：RM388\n• Package B（60分钟女性护理配套）：RM268\n\nPackage A 的上述价格为使用优惠券后的价格 😊",3000),pricingDeliveredBotMessage:true};
 const imageA={...turn("assistant","优惠后仅需 RM3️⃣8️⃣8️⃣\n✅骨盆调整与体态矫正疗程\n✅子宫草药护理",2000),pricingDeliveredBotMessage:true,verifiedOutboundImageUrl:"https://example.test/a"};
 const imageB={...turn("assistant","现在只需 RM2️⃣6️⃣8️⃣\n✅骨盆调整与体态矫正疗程",1000),pricingDeliveredBotMessage:true,verifiedOutboundImageUrl:"https://example.test/b"};
 a.conversationHistory=[turn("user","你好，我想了解骨盆调理",6000),turn("assistant","骨盆调理是徒手护理",5000),turn("user","那我要准备多少预算呢？",4000),menu,imageA,imageB,turn("user",a.customerText,0)];
 const d=resolveModelLedPricingDecision(a);
 assert.deepEqual(d?.prices.map(p=>p.price),["RM268"]);
 const approved=resolveApprovedPricingAssessment({...a,mode:"enabled",aiDecision:d});
 assert.equal(approved.reason,"approved");
 const media=await resolvePricePromotionForReply({...a,aiPricingEnabled:true,pricingDecision:approved.decision,
  treatment:d.treatment,verifiedServiceFromText:d.treatment,textSendSucceeded:true,contactId:1,
  wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,now:new Date(now)});
 assert.deepEqual(media?.packages?.map(p=>p.name),["Package B"]);
 for(const invalid of [
   {...imageB,pricingDeliveredBotMessage:false},
   {...imageB,verifiedOutboundImageUrl:"https://example.test/other"},
   {...imageB,pricingStaffAuthored:true},
   {...imageB,verifiedOutboundImageUrl:null,content:"骨盆调理可以预约星期三"},
 ]){
   const b={...a,conversationHistory:a.conversationHistory.map(t=>t===imageB?invalid:t)};
   assert.equal(resolveModelLedPricingDecision(b),null,JSON.stringify(invalid));
 }
 const wrongMenu={...a,conversationHistory:a.conversationHistory.map(t=>t===menu?{...menu,content:menu.content.replace("RM268","RM288")}:t)};
 assert.equal(resolveModelLedPricingDecision(wrongMenu),null);
 assert.equal(resolveModelLedPricingDecision({...a,modelIntent:{...a.modelIntent,promotionOption:"Package A"}}),null);
});

test("live WhatsApp: old or resolved price enquiries do not authorize new treatment introductions",()=>{
 const {resolveRecentPriceSelection}=require("../src/utils/priceConversationRecovery");
 const {resolveShadowPriceException}=require("../src/utils/shadowPriceException");
 const check=(current,prior)=>{
  const a=args(current,"3D 小颜术");
  a.modelIntent.priceQuery=false;
  a.conversationHistory=[...prior,turn("user",current,0)];
  assert.equal(resolveRecentPriceSelection({...a,session:a.conversationHistory}),null,current);
  assert.equal(resolveShadowPriceException(a),null,current);
  assert.equal(resolveModelLedPricingDecision(a),null,current);
 };
 check("我也想了解3D小颜术",[
  turn("user","你好，我想了解骨盆调理",7000),
  turn("assistant","骨盆调理是徒手护理",6000),
  turn("user","那我要准备多少预算呢？",5000),
  turn("assistant","骨盆调理\nPackage A: RM388\nPackage B: RM268",4000),
  turn("user","比较便宜的那个多少钱？",3000),
  turn("assistant","请问你指的是哪一个配套或疗程呢？我帮你确认正确的价格哦 😊",2000),
 ]);
 check("I'm interested in the 3D facial treatment.",[
  turn("user","我也想了解3D小颜术",6000),
  turn("assistant","3D 小颜术 First Trial RM388",5000),
  turn("user","不是3D，我想了解9D的价钱",4000),
  turn("assistant","9D 逆龄抗衰 First Trial RM488",3000),
 ]);
 // Preserve genuine unanswered price selection after the bot's menu.
 const a=args("3D","3D 小颜术");
 a.conversationHistory=[turn("user","多少钱？",4000),turn("assistant","请问想了解哪项疗程的价格？3D 小颜术 或 9D 逆龄抗衰",3000),turn("user","3D",0)];
 assert.equal(resolveRecentPriceSelection({...a,session:a.conversationHistory})?.name,"3D 小颜术");
});
