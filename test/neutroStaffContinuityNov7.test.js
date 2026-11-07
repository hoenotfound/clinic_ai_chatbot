"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {resolveVerifiedStaffFacialPriceReply} = require("../src/utils/priceConversationRecovery");
const {recentVerifiedPricingSession} = require("../src/utils/shadowPriceException");
const {resolveNeutroFacialDeviceReview} = require("../src/utils/neutroFacialDeviceReview");
const {isSimpleGreeting,safeGreetingReply} = require("../src/utils/simpleGreetingReviewRecovery");
const {categorizeAiReview,hasClinicalMediaRisk} = require("../src/utils/aiReviewPolicy");

const now=Date.now();
const turn=(role,content,secondsAgo=0,staff=false)=>({
 role,content,pricingCreatedAtMs:now-secondsAgo*1000,pricingStaffAuthored:staff,
});
const services=[{name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},{name:"3D + 9D 组合"}];
const aliases=[
 {alias:"3D",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"},
 {alias:"3D+9D",officialService:"3D + 9D 组合"},
 {alias:"Pelvic",officialService:"骨盆调理"},
];
const promotions=[
 {name:"3D 小颜术 First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
  validFrom:"2000-01-01",validUntil:"2999-12-31",
  pricing:{currency:"MYR",offer:488,normal:888},
  caption:"3D 小颜术 First Trial 原价 RM888 优惠价 RM488"},
 {name:"9D 逆龄抗衰 First Trial",linkedService:"9D 逆龄抗衰",sendOnPriceQuery:true,
  validFrom:"2000-01-01",validUntil:"2999-12-31",
  pricing:{currency:"MYR",offer:488,normal:1288},
  caption:"9D 逆龄抗衰 First Trial 原价 RM1288 优惠价 RM488"},
];
const staffMenu="[Verified STAFF message] Regarding your enquiry just now regarding facial care, we have two services:\n"+
 "1. 3D 小颜术: non-injection manual facial contour care.\n"+
 "2. 9D 逆龄抗衰: device-based firming and lifting.\n"+
 "Which concern would you like to improve?";
const history=[
 turn("user","i ask previously",1000),
 turn("assistant",staffMenu,750,true),
 turn("user","how much",600),
];
const priced=(messages=history,offers=promotions,current="how much")=>resolveVerifiedStaffFacialPriceReply({
 customerText:current,conversationHistory:messages,
 services,serviceAliases:aliases,promotions:offers,language:"en",now,
});

test("recent authenticated staff 3D/9D menu lets a new explicit price question receive two verified text prices",()=>{
 // Do not widen the existing staff-free multi-step pricing authorization.
 assert.equal(recentVerifiedPricingSession(history,"how much",now),null);
 const result=priced();
 assert.equal(result?.source,"verified_staff_facial_menu_two_offers");
 assert.deepEqual(result?.prices.map(x=>[x.treatment,x.amount]),[
  ["3D 小颜术","RM488"],["9D 逆龄抗衰","RM488"],
 ]);
 assert.match(result.reply,/First Trial/iu);
 assert.doesNotMatch(result.reply,/RM688|RM388|pelvic|骨盆|combo/iu);
});

test("staff pricing context is never an independent price source or media permission",()=>{
 const unsafe=[
  [...history.slice(0,-2),turn("assistant",staffMenu,31*60,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu.replace(/facial|face/giu,"body"),750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu.replace("2. 9D","2. Pelvic 9D"),750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu+" RM688",750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu+" Book an appointment!",750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu+" 3D+9D combo",750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu.replace("9D 逆龄抗衰","骨盆调理"),750,true),history.at(-1)],
  [...history.slice(0,-2),turn("assistant",staffMenu,750,false),history.at(-1)],
  [...history.slice(0,-1),turn("user","how much for my second session?",600)],
  [...history.slice(0,-1),turn("user","how much for the 3D+9D combo?",600)],
 ];
 for(let i=0;i<unsafe.length;i++){
  assert.equal(priced(unsafe[i],promotions,unsafe[i].at(-1).content),null,"unsafe case "+i);
 }
 assert.equal(priced(history,[promotions[0]]),null);
 assert.equal(priced(history,[promotions[0],{...promotions[1],validUntil:"2001-01-01"}]),null);
 assert.equal(priced(history,[promotions[0],{...promotions[1],pricing:{currency:"MYR",offer:999,normal:1288}}]),null);
});

test("device verification acknowledges questions after staff explains 9D without inventing a model",()=>{
 const deviceHistory=[
  turn("user","facial care",1100),
  turn("assistant",staffMenu,720,true),
  turn("user","which device u use?",600),
 ];
 const result=resolveNeutroFacialDeviceReview({
  customerText:"which device u use?",conversationHistory:deviceHistory,services,language:"en",now,
 });
 assert.equal(result?.reviewType,"information");
 assert.match(result.reply,/ask our team to confirm/iu);
 assert.doesNotMatch(result.reply,/HIFU|RF|Ultherapy|Ultraformer|brand is/iu);
 const invalid=resolveNeutroFacialDeviceReview({
  customerText:"which device u use?",
  conversationHistory:[...deviceHistory.slice(0,-2),turn("assistant",staffMenu,31*60,true),deviceHistory.at(-1)],
  services,now,
 });
 assert.equal(invalid,null);
 const clinical=resolveNeutroFacialDeviceReview({
  customerText:"is the device safe in pregnancy?",
  conversationHistory:[...deviceHistory.slice(0,-1),turn("user","is the device safe in pregnancy?",600)],
  services,now,
 });
 assert.equal(clinical,null);
});

test("simple greetings are not clinical reviews and genuine symptoms remain protected",()=>{
 for(const [value,language] of [["hi","en"],["Hi 👋","en"],["你好","zh"],["hai","ms"],["Good morning!","en"]]){
  assert.equal(isSimpleGreeting(value),true,value);
  assert.equal(categorizeAiReview(value,"clinical"),"information",value);
  assert.ok(safeGreetingReply(language).length>10);
 }
 for(const value of ["hi I am pregnant","hello, is this safe after surgery?","hi my wound is bleeding","can I do treatment while pregnant?"]){
  assert.equal(isSimpleGreeting(value),false,value);
  assert.equal(categorizeAiReview(value,"clinical"),"clinical",value);
 }
 assert.equal(hasClinicalMediaRisk("hi"),false);
});

test("server preserves ownership checks, booking holds and review evidence for new recoveries",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 assert.match(source,/messagesRepo\.hasActiveStaffBookingConversation\(contact\.id,savedInbound\.id\)/u);
 assert.match(source,/resolveVerifiedStaffFacialPriceReply\(\{/u);
 assert.match(source,/isSimpleGreeting\(text\)/u);
 assert.match(source,/greetingEvidence\?\.pendingClinicalReview === false/u);
 assert.match(source,/deviceEvidence\?\.pendingClinicalReview === false/u);
 assert.match(source,/aiReplyCancellation\.settleBeforeSend/u);
 assert.match(source,/await auditResultMediaEarlyExit\("two_treatments_text_only"\)/u);
});

test("medical suitability questions skip the temporary booking hold and retain clinical review",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 // This boundary occurs BEFORE AI generation. Clinical concerns must reach
 // the existing review pipeline even when staff is arranging a booking.
 assert.match(server,/!hasClinicalMediaRisk\(text\)\s*&&\s*!isExplicitStaffRequest\(text\)[\s\S]{0,170}hasActiveStaffBookingConversation/u);
 for(const message of [
  "Is 9D safe if I am pregnant?",
  "Can I do 9D after surgery?",
  "我怀孕了，可以做9D吗？",
  "Saya mengandung, boleh buat 9D?",
 ]){
  assert.equal(hasClinicalMediaRisk(message),true,message);
  assert.equal(categorizeAiReview(message,"clinical"),"clinical",message);
 }
});
