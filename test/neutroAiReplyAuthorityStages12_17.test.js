"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {ensureVerifiedPriceReply,guardUnfulfilledPriceQuote}=require("../src/utils/verifiedPriceReply");
const {confirmedSingleBranchLocationAnswer,verifyLocationDraft}=require("../src/utils/verifiedPricingBusinessFacts");
const {correctReplyLanguage}=require("../src/utils/replyLanguageGuard");
const {preserveOriginalIntroFacts}=require("../src/utils/localizedIntroGuard");
const {rm68CampaignPromptFacts}=require("../src/config/neutroRm68CampaignConfig");
const defaults=require("../src/config/neutroRm68Campaign.default.json");
const {createReplyOverrideAudit}=require("../src/utils/neutroAiReplyAuthority");

const treatment="3D 小颜术";
const promotion={name:"3D 小颜术 First Trial",linkedService:treatment,sendOnPriceQuery:true,
  validFrom:"2000-01-01",validUntil:"2999-12-31",pricing:{offer:388,currency:"MYR"}};
const args={customerText:"3D小颜术有优惠吗？",treatment,services:[{name:treatment}],
  promotions:[promotion],pricingDecision:{treatment,source:"customer_current_offer",prices:[{name:"Main offer",price:"RM388"}]},
  language:"zh",preserveNaturalReply:true};

test("enabled authority preserves a simple fully verified current-offer quotation",()=>{
  const reply="是的，3D 小颜术 First Trial 价格是 RM388 😊";
  const result=ensureVerifiedPriceReply({...args,reply});
  assert.equal(result.reply,reply);
  assert.equal(result.restored,false);
});

test("wrong amount and incomplete quote still fall back, without a forced sales invitation",()=>{
  for(const reply of ["3D 小颜术 First Trial RM188","你想知道哪个疗程的价钱？"]){
    const result=ensureVerifiedPriceReply({...args,reply});
    assert.equal(result.restored,true);
    assert.match(result.reply,/RM388/);
    assert.doesNotMatch(result.reply,/RM188|想了解优惠包含什么/);
  }
  const legacy=ensureVerifiedPriceReply({...args,preserveNaturalReply:false,reply:"请问哪个疗程？"});
  assert.match(legacy.reply,/想了解优惠包含什么/);
});

test("a simple configured service price can preserve the AI quote, but not a wrong amount",()=>{
  const service="测试护理";
  const opts={customerText:"测试护理多少钱？",treatment:service,services:[{name:service}],
    pricingDecision:{treatment:service,source:"model_led_customer_context",prices:[],servicePrice:"RM150"},
    language:"zh",preserveNaturalReply:true};
  const reply="测试护理 价格是 RM150 😊";
  assert.deepEqual(ensureVerifiedPriceReply({...opts,reply}),{reply,restored:false,verifiedQuote:true});
  assert.match(ensureVerifiedPriceReply({...opts,reply:"测试护理 RM100"}).reply,/RM150/);
});

test("the combined commercial boundary removes unsent-media promises but keeps verified amounts",()=>{
  const original="3D 小颜术 First Trial RM388。\n我会发图片给你参考。";
  const result=guardUnfulfilledPriceQuote(original,"zh",{validateMediaPromise:true});
  assert.equal(result.mediaChanged,true);
  assert.match(result.afterMediaReply,/RM388/);
  assert.doesNotMatch(result.reply,/发图片/);
  const both=guardUnfulfilledPriceQuote("9D 的价格是：\n我会发图片给你参考。","zh",{validateMediaPromise:true});
  assert.equal(both.mediaChanged,true);
  assert.equal(both.changed,true);
  assert.doesNotMatch(both.reply,/9D 的价格是：|发图片/);
});

test("natural location validation accepts neutral courtesy, not unverified directions or a second branch",()=>{
  const address="12 Jalan 19, Petaling Jaya, Selangor";
  const facts=confirmedSingleBranchLocationAnswer({customerText:"Where is your clinic?",branches:[{name:"Petaling Jaya",address}],language:"en",resolvedLanguage:"en",omitInvitation:true});
  const opts={allowNeutralCourtesy:true};
  const natural="Hi, our address: "+address+". Thank you 😊";
  assert.equal(verifyLocationDraft(natural,facts,opts),"verified_address_only");
  assert.notEqual(verifyLocationDraft(natural,facts),"verified_address_only");
  for(const reply of ["Our address: "+address+". Free parking.",
    "Our address: "+address+". Another branch in Puchong.",
    "Our address: 23 Jalan 19, Petaling Jaya, Selangor.",
    "Our address: "+address+". Your appointment is confirmed."]){
    assert.notEqual(verifyLocationDraft(reply,facts,opts),"verified_address_only",reply);
  }
});

test("the language failure path does not ask the customer to repeat the question or preserve unsafe actions",async()=>{
  const original={text:"好的，我可以帮您介绍。",outcome:"normal",flagged:false,reviewRequired:false,
    serviceQuery:false,priceQuery:false,packageQuery:false,bookingReady:false,details:{}};
  let calls=0;
  const result=await correctReplyLanguage(original,[{role:"user",content:"Could you explain this?"}],
    {replyLanguage:"en",preserveNaturalReply:true},{getReply:async()=>{calls++;throw Error("provider timeout")},parseReply:JSON.parse});
  assert.equal(calls,1);
  assert.equal(result.flagged,true);
  assert.equal(result.reviewRequired,true);
  assert.equal(result.reviewType,"information");
  assert.equal(result.outcome,"review_required");
  assert.equal(result.languageCorrectionFailed,true);
  assert.match(result.text,/accurate English reply/);
  assert.doesNotMatch(result.text,/What would you like to know/);
  assert.equal(result.priceQuery,false);
  assert.equal(result.bookingReady,false);
});

test("source introduction facts remain intact with a localized fallback heading",()=>{
  const source="欢迎！体验优惠 RM488";
  const result=preserveOriginalIntroFacts(source,"Hello, welcome!",{language:"ms"});
  assert.equal(result.usedOriginalFallback,true);
  assert.match(result.reply,/Pengenalan asal pusat/);
  assert.ok(result.reply.includes(source));
});

test("campaign prompt uses validated stored date, amount and duration; invalid configuration fails closed",()=>{
  const config={neutroRm68Campaign:JSON.parse(JSON.stringify(defaults))};
  const both=rm68CampaignPromptFacts("both",config);
  assert.match(both,/RM68/);
  assert.match(both,/5 December 2026 and 6 December 2026/);
  assert.match(both,/45 minutes breast care, 90 minutes total/);
  assert.doesNotMatch(rm68CampaignPromptFacts("dec6",config),/5 December/);
  assert.doesNotMatch(rm68CampaignPromptFacts("expired",config),/RM68 first trial/);
  assert.doesNotMatch(rm68CampaignPromptFacts("both",{neutroRm68Campaign:{...config.neutroRm68Campaign,priceMYR:388}}),/RM(?:68|388) first trial/);
});

test("audit reports multiple distinct changes without including customer text",()=>{
  const logs=[];const audit=createReplyOverrideAudit(line=>logs.push(line));
  audit.note("configuredAdOpening");
  audit.change("resolveNeutroComboOfferReply","original","changed");
  audit.change("finalLanguageFallback","changed","translated");
  audit.flush({contactId:123,inboundId:456,original:"original",final:"translated",outcome:"normal"});
  assert.equal(logs.length,1);
  assert.match(logs[0],/configuredAdOpening.*resolveNeutroComboOfferReply.*finalLanguageFallback/);
  assert.doesNotMatch(logs[0],/original|translated/);
});
