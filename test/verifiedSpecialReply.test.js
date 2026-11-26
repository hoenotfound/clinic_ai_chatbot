"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {selectVerifiedSpecialReply,verifiedEquivalentReply}=require("../src/utils/verifiedSpecialReply");

const decision={reply:"Here's the difference:\nPackage A (RM388 | 150 minutes):\n• Pelvic care\n• Meridian massage\nPackage B (RM268 | 60 minutes):\n• Pelvic care\nOur practitioner can help you choose.",
  heading:"Here's the difference:",conclusion:"Our practitioner can help you choose.",
  verifiedPackages:[{name:"Package A",price:388,title:"150 minutes",includedItems:["Pelvic care","Meridian massage"]},{name:"Package B",price:268,title:"60 minutes",includedItems:["Pelvic care"]}]};
const select=draft=>selectVerifiedSpecialReply({draft,decision,language:"en",kind:"pelvic"});
test("pelvic comparison preserves reordered independently verified package facts without compulsory invitation",()=>{
  const draft="Hi 😊\nPackage B (MYR 268.00 | 60 minutes):\n• Pelvic care\nPackage A (RM388 | 150 minutes):\n• Meridian massage\n• Pelvic care";
  assert.equal(select(draft),draft);
  for(const bad of [draft.replace("MYR 268.00","RM388"),draft.replace("60 minutes","90 minutes"),draft.replace("Meridian massage","Free gifts"),draft+"\nGuaranteed results",draft.replace("• Meridian massage","❌ Meridian massage"),draft.replace("RM388","RM388.50"),draft.replace("• Meridian massage","• Meridian massage\n• Free consultation")])assert.equal(select(bad),decision.reply,bad);
});
test("combo reply equivalence accepts currency formats and neutral greetings but not unsupported conditions",()=>{
  const reference="The current 3D + 9D combination offer is RM688 😊 Our practitioner will assess whether both treatments are suitable.";
  const draft="Hello 😊\nThe current 3D + 9D combination offer is MYR 688.00. Our practitioner will assess whether both treatments are suitable.";
  // Exact sentence boundary is part of the approved claim. Currency format,
  // friendly decoration and standalone greetings may differ.
  const equivalent=draft.replace("688.00. Our","688.00 😊 Our");
  assert.equal(verifiedEquivalentReply(equivalent,reference),true);
  for(const bad of [reference.replace("RM688","RM6880"),reference.replace("RM688","RM688 + 20"),reference.replace("suitable","guaranteed to work"),"❌ "+reference])assert.equal(verifiedEquivalentReply(bad,reference),false,bad);
});
test("later-session package invitation remains exact for delivery history recognition",()=>{
  const reference="Our team can explain the available package options.";
  const draft="Hi 😊\n"+reference;
  for(const mode of ["before_promo","staff_handoff","suggest_package"]){
    const reply=selectVerifiedSpecialReply({draft,decision:{reply:reference,mode},language:"en",kind:"subsequent"});
    assert.equal(reply,mode==="suggest_package"?reference:draft);
  }
});


test("verified combo price survives natural multilingual paraphrases but no unsupported claims",()=>{
  const {comboDraftMatches}=require("../src/utils/verifiedSpecialReply");
  const offer={treatment:"3D + 9D 组合",price:"RM688",mode:"direct",complimentaryMeridianHour:true,
    reply:"The current 3D + 9D combination offer is RM688 😊 Our practitioner will assess whether both treatments are suitable."};
  for(const [language,draft] of [
    ["en","If you'd like to experience both 3D and 9D together, our current combo is only RM688 ya 😊"],
    ["zh","3D + 9D 组合目前优惠价 RM688 😊"],
    ["ms","Harga promosi kombo 3D + 9D sekarang hanya MYR 688.00 😊"],
    ["en","The 3D + 9D combo is RM688, with a complimentary one-hour meridian massage"],
  ]){
    assert.equal(comboDraftMatches(draft,offer),true,draft);
    assert.equal(selectVerifiedSpecialReply({draft,decision:offer,kind:"combo",language}),draft);
  }
  for(const draft of [
    "The 3D + 9D combo is not RM688",
    "The 3D + 9D combo is RM688 each",
    "The 3D + 9D combo is RM688 for 3 sessions",
    "The 3D + 9D combo is RM688 including free ultrasound",
    "The 3D + 9D combo is RM688. Guaranteed results.",
    "The 3D + 9D combo is RM688 after voucher",
    "The 3D + 9D combo is RM688?",
    "3D + 9D 组合 RM688，包你一次见效",
    "Harga promosi kombo 3D + 9D RM688, dijamin sembuh",
  ]) assert.equal(comboDraftMatches(draft,offer),false,draft);
  const gift="The 3D + 9D combo is RM688, with a complimentary one-hour meridian massage";
  assert.equal(comboDraftMatches(gift,{...offer,complimentaryMeridianHour:false}),false);
});

test("package comparison accepts verified normal and voucher amounts as distinct claims",()=>{
  const enriched={...decision,verifiedPackages:decision.verifiedPackages.map(p=>({...p,money:{offer:p.price,normal:p.price+100,voucher:100,afterVoucher:true}}))};
  const draft="Package A (RM388 | 150 minutes):\nNormal price RM488\nRM100 voucher\n• Pelvic care\n• Meridian massage\nPackage B (MYR 268.00 | 60 minutes):\nNormal price RM368\nRM100 voucher\n• Pelvic care";
  const choose=reply=>selectVerifiedSpecialReply({draft:reply,decision:enriched,language:"en",kind:"pelvic"});
  assert.equal(choose(draft),draft);
  for(const bad of [draft.replace("RM488","RM588"),draft.replace("RM100 voucher","RM200 voucher"),draft.replace("Normal price RM368","RM368"),draft.replace("RM388 |","not RM388 |")])assert.equal(choose(bad),enriched.reply,bad);
});

test("staff handoff allows verified unpriced paraphrase without changing suggestion history",()=>{
  const decision={mode:"staff_handoff",treatment:"3D 小颜术",reply:"Our team can confirm your individual-session rate."};
  const draft="Our team can confirm the subsequent session price for 3D 小颜术.";
  assert.equal(selectVerifiedSpecialReply({draft,decision,language:"en",kind:"subsequent"}),draft);
  for(const bad of [draft+" RM888",draft.replace("3D 小颜术","9D 逆龄抗衰"),draft.replace("can confirm","has confirmed")])assert.equal(selectVerifiedSpecialReply({draft:bad,decision,language:"en",kind:"subsequent"}),decision.reply);
});

test("routine recovery state rejects missing or pending evidence and clears all action flags together",()=>{
  const {routineReviewTextOnlyState}=require("../src/utils/neutroAiReplyAuthority");
  for(const evidence of [undefined,null,{}, {pendingClinicalReview:true},{pendingClinicalReview:null}])assert.equal(routineReviewTextOnlyState(evidence,"Verified facts"),null);
  const state=routineReviewTextOnlyState({pendingClinicalReview:false},"Verified facts");
  assert.deepEqual(state,{reply:"Verified facts",flagged:false,reviewRequired:false,reviewType:null,bookingReady:false,serviceQuery:false,serviceQuerySource:null,priceQuery:false,packageQuery:false,details:null,clinicalAcknowledgement:null,reviewContinuationTextOnly:true});
});
