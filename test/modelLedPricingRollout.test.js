"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveModelLedPricingDecision,shouldApplyModelLedPricing}=require("../src/utils/aiPricingIntentDecision");
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
 for(const current of ["How long does it take?","不要报价","How much is the deposit?","太贵了","Where is your branch?","我有乳腺结节","可以跟进我，有优惠也发我看看"]){
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
test("shadow and off never apply semantic decision; enabled fills gaps only",()=>{
 const d=resolveModelLedPricingDecision(args());assert.ok(d);
 const base={mode:"enabled",legacyMode:"shadow",legacyApproval:{decision:null},semanticApproval:{decision:d}};
 assert.equal(shouldApplyModelLedPricing(base),true);
 for(const override of [{mode:"off"},{mode:"shadow"},{legacyMode:"off"},{legacyCandidate:d},{legacyApproval:{decision:d}},{hasSpecialDecision:true},{semanticApproval:{decision:null}}]){
  assert.equal(shouldApplyModelLedPricing({...base,...override}),false,JSON.stringify(override));
 }
 for(const override of [{flagged:true},{bookingReady:true},{marketingStopQuestion:true},{keywordReason:"review"}]){
  assert.equal(resolveApprovedPricingAssessment({...args(),mode:"enabled",aiDecision:d,...override}).decision,null);
 }
});
