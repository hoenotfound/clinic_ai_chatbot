"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveNeutroComboOfferReply, resolveNeutroComboMediaPricingDecision,
} = require("../src/utils/neutroComboOfferReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

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

test("a previous combo refusal prevents offering it again",()=>{
 const current="3d的多少钱？";
 const session=[turn("user","9d",260),turn("assistant","9D RM488",245),
   turn("user","不要组合，我要分开看",220),
   turn("assistant","好的，分开了解",200),
   turn("user",current,80)];
 assert.equal(check(current,session,{verifiedIndividualQuote:true}),null);
});

test("the existing Neutro combo promotion can be verified from consistent RM688 copy",()=>{
 const current="3D+9D组合多少钱？";
 const liveShaped={...combo,pricing:null,
   caption:"✨ 9D + 3D 组合限时优惠: RM688",
   followUpMessage:"Hi～组合体验价只需 RM688！还额外免费送你 1 小时经络穴位按摩！",
   mediaTranslations:{en:{caption:"9D + 3D Limited-Time Combo Offer: RM688"}},
   followUpTranslations:{en:"Includes meridian massage"}};
 const result=check(current,[turn("user",current,60)],{promotions:[liveShaped]});
 assert.equal(result?.mode,"direct");
 assert.match(result?.reply||"",/RM688/u);
});

test("separate price wording cannot be mistaken for an explicit combo quote",()=>{
 const queries=["3D+9D 分开多少钱？","3D+9D分别多少钱？",
   "3D+9D separately how much?", "3D+9D masing-masing individually price?"];
 for(const text of queries) {
   const decision=check(text,[turn("user",text,40)]);
   assert.notEqual(decision?.mode,"direct",text);
 }
});

test("both-treatment price enquiry quotes the two verified trials and the combo together",()=>{
 const current="3D和9D多少钱？";
 const standalone=[
   {name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",
     sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
     pricing:{currency:"MYR",offer:488,normal:888},
     caption:"3D First Trial 优惠价 RM488",imageUrl:"https://example.test/3d.png"},
   {name:"9D 逆龄抗衰 First Trial",linkedService:"9D 逆龄抗衰",
     sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
     pricing:{currency:"MYR",offer:488,normal:1288},
     caption:"9D First Trial 优惠价 RM488",imageUrl:"https://example.test/9d.png"},
 ];
 const result=check(current,[turn("user",current,60)],{promotions:[...standalone,combo]});
 assert.equal(result?.mode,"direct");
 assert.match(result.reply,/3D 和 9D 分开体验/u);
 assert.equal((result.reply.match(/RM488/gu)||[]).length,2);
 assert.equal((result.reply.match(/RM688/gu)||[]).length,1);
});

test("customer refusing one treatment is never sold the combination",()=>{
 for(const current of [
   "我只想做9D，3D不要，多少钱？",
   "不要3D，9D多少钱？",
   "Only 9D, not 3D. What is the price?",
   "只要3D不要9D，多少钱",
 ]) {
   assert.equal(check(current,[turn("user",current,60)],{
     verifiedIndividualQuote:true
   }),null,current);
 }
});


const mediaCombo={...combo,
 imageUrl:"https://da-chatbot-neutro-sense-tcm.onrender.com/promo-images/22",
 caption:"✨ 9D + 3D 组合限时优惠: RM688"};
const comboQuery="3D+9D组合多少钱？";
const comboSession=[turn("user",comboQuery,30)];
function comboMedia(promos=[mediaCombo],text=comboQuery,session=comboSession,extra={}){
 const decision=check(text,session,{promotions:promos});
 const pricingDecision=resolveNeutroComboMediaPricingDecision({
   comboOfferDecision:decision,promotions:promos,customerText:text,
   session,reply:decision?.reply,now,...extra
 });
 return {decision,pricingDecision};
}
async function selectMedia({promos=[mediaCombo],text=comboQuery,session=comboSession,
 overrides={},recentlySent=false,unconfirmed=false,replyOverride}={}){
 const {decision,pricingDecision}=comboMedia(promos,text,session,{
   ...(replyOverride!==undefined?{reply:replyOverride}:{})
 });
 const reasons=[];
 const selected=await resolvePricePromotionForReply({
   priceQuery:true,packageQuery:false,
   aiPricingEnabled:true,pricingDecision,
   treatment:pricingDecision?.treatment,
   verifiedServiceFromText:pricingDecision?.treatment,
   customerText:text,conversationHistory:session,
   services,serviceAliases,promotions:promos,
   flagged:false,bookingReady:false,keywordReason:null,needsAttention:false,
   textSendSucceeded:true,language:"zh",contactId:8880,
   wasPromoRecentlySent:async()=>recentlySent,
   hasUnconfirmedMediaDelivery:async()=>unconfirmed,
   onSkip:reason=>reasons.push(reason),
   ...overrides,
 });
 return {decision,pricingDecision,selected,reasons};
}
test("verified RM688 combo selects exactly its approved picture through normal promotion guard",async()=>{
 const {pricingDecision,selected}=await selectMedia();
 assert.equal(pricingDecision?.source,"verified_neutro_combo_image");
 assert.equal(pricingDecision?.prices?.length,1);
 assert.equal(selected?.promotion.linkedService,"3D + 9D 组合");
 assert.equal(selected?.packages?.length,1);
 assert.ok(selected.packages[0].imageUrl.endsWith("/promo-images/22"));
 assert.match(selected.packages[0].caption,/RM688/u);
});
test("combo image is not authorized for absent, mismatched or unverified offer",()=>{
 assert.equal(comboMedia([{...mediaCombo,imageUrl:""}]).pricingDecision,null);
 assert.equal(comboMedia([{...mediaCombo,pricing:{currency:"MYR",offer:999}}]).pricingDecision,null);
 assert.equal(comboMedia([mediaCombo,{...mediaCombo}]).pricingDecision,null);
 const good=comboMedia();
 const unquoted=resolveNeutroComboMediaPricingDecision({
   comboOfferDecision:good.decision,promotions:[mediaCombo],
   customerText:comboQuery,session:comboSession,
   reply:"We will check your price",now
 });
 assert.equal(unquoted,null);
});
test("combo price image respects accepted text, duplicate and uncertain delivery",async()=>{
 for (const [name,opts,expected] of [
   ["text rejected",{overrides:{textSendSucceeded:false}},"text_not_accepted"],
   ["staff reviewing",{overrides:{needsAttention:true}},"staff_review_or_takeover"],
   ["booking ready",{overrides:{bookingReady:true}},"booking_ready"],
   ["clinical review",{overrides:{flagged:true}},"safety_or_review"],
   ["already sent",{recentlySent:true},"all_graphics_already_sent"],
   ["unconfirmed Meta receipt",{unconfirmed:true},"unconfirmed_media_delivery"],
 ]) {
   const {selected,reasons}=await selectMedia(opts);
   assert.equal(selected,null,name);
   assert.ok(reasons.includes(expected),name+" / "+reasons);
 }
});
test("combo image never sends for customer refusal or ordinary 9D-only prices",async()=>{
 for(const text of ["3D+9D组合多少钱？不要组合","9D多少钱？","只要9D不要3D，多少钱？"]){
   const session=[turn("user",text,30)];
   assert.equal(comboMedia([mediaCombo],text,session).pricingDecision,null,text);
 }
});
