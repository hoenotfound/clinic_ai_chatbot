"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {localizedFollowUpText}=require("../src/services/whatsappSecondaryFollowUpLanguage");
const chinese="你之前咨询的护理，如果还有哪里想了解的，我可以帮你整理一下 😊";
test("2h and 6h followups honor the customer's evidenced language",()=>{
 for(const slot of [2,6]){
  const en=localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["How much is the treatment?"]});
  assert.match(en,/treatment/i);
  assert.doesNotMatch(en,/你/);
  const ms=localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["Saya nak tahu harga rawatan"]});
  assert.match(ms,/rawatan/i);
  assert.doesNotMatch(ms,/你/);
  assert.equal(localizedFollowUpText({slot,originalText:chinese,
   customerTexts:["你好我想了解骨盆调理"]}),chinese);
 }
});
test("preceding context is used when the last message is 'ok' or 'price'",()=>{
 const text=localizedFollowUpText({slot:2,originalText:chinese,
  customerTexts:["price","Saya nak tahu harga"]});
 assert.match(text,/rawatan/);
});
test("no language evidence does not spend a follow-up attempt",()=>{
 assert.equal(localizedFollowUpText({slot:2,originalText:chinese,
  customerTexts:["ok","hi"]}),null);
 assert.equal(localizedFollowUpText({slot:6,originalText:chinese,
  customerTexts:[]}),null);
});
test("20h AI content is unaffected by localization",()=>{
 const text="AI personalized message";
 assert.equal(localizedFollowUpText({slot:20,originalText:text,customerTexts:[]}),text);
});

const {resolveFollowUpTreatment}=require("../src/services/whatsappSecondaryFollowUpLanguage");
const liveClinic={
 services:[{name:"骨盆调理"},{name:"9D 逆龄抗衰"}],
 serviceAliases:[{alias:"pelvic",officialService:"骨盆调理"},
   {alias:"9D lift",officialService:"9D 逆龄抗衰"},
   {alias:"9D",officialService:"9D 逆龄抗衰"},
   {alias:"9D逆龄抗衰",officialService:"9D 逆龄抗衰"}],
 automatedFollowUp:{
   message:"Primary clinic Chinese 2h",
   translations:{en:"Primary clinic English 2h",ms:"Primary clinic Malay 2h",
     zh:"Primary clinic Chinese 2h"},
   serviceOverrides:[{serviceName:"骨盆调理",
     message:"Primary pelvic Chinese 2h",
     translations:{en:"Primary pelvic English 2h",ms:"Primary pelvic Malay 2h",
       zh:"Primary pelvic Chinese 2h"}}],
   additionalSteps:[{message:"Primary clinic Chinese 6h",
     translations:{en:"Primary clinic English 6h",ms:"Primary clinic Malay 6h",
       zh:"Primary clinic Chinese 6h"},
     serviceOverrides:[{serviceName:"9D 逆龄抗衰",
       message:"Primary 9D Chinese 6h",
       translations:{en:"Primary 9D English 6h",ms:"Primary 9D Malay 6h",
         zh:"Primary 9D Chinese 6h"}}]}],
 },
};
test("secondary reuses exact configured primary 2h/6h translations",()=>{
 for(const [slot,customerTexts,treatmentInterest,expected] of [
   [2,["How much is pelvic treatment?"],"骨盆调理","Primary pelvic English 2h"],
   [2,["Saya nak tahu harga"],"骨盆调理","Primary pelvic Malay 2h"],
   [2,["你好骨盆调理"],"骨盆调理","Primary pelvic Chinese 2h"],
   [6,["Can you explain 9D lift?"],"骨盆调理","Primary 9D English 6h"],
   [6,["Nak tahu rawatan 9D"],"骨盆调理","Primary 9D Malay 6h"],
   [6,["9D逆龄抗衰"],"骨盆调理","Primary 9D Chinese 6h"],
 ]){
   assert.equal(localizedFollowUpText({slot,originalText:"Old secondary text",
     customerTexts,treatmentInterest,clinicConfig:liveClinic}),expected);
 }
});
test("latest customer's treatment overrides stale CRM; ambiguous treatments use general copy",()=>{
 assert.equal(resolveFollowUpTreatment({clinicConfig:liveClinic,
   treatmentInterest:"骨盆调理",customerTexts:["What about 9D lift?"]}),"9D 逆龄抗衰");
 assert.equal(localizedFollowUpText({slot:2,originalText:"Old secondary text",
   customerTexts:["Can you explain pelvic and 9D lift?"],treatmentInterest:"骨盆调理",
   clinicConfig:liveClinic}),"Primary clinic English 2h");
 assert.equal(localizedFollowUpText({slot:2,originalText:"Old secondary text",
   customerTexts:["ok"],treatmentInterest:"骨盆调理",
   clinicConfig:liveClinic}),null);
});
test("changes in clinic config update future secondary reminders without redeploy",()=>{
 const a=localizedFollowUpText({slot:2,originalText:"stale",customerTexts:["How much?"],
   treatmentInterest:"骨盆调理",clinicConfig:liveClinic});
 const changed=structuredClone(liveClinic);
 changed.automatedFollowUp.serviceOverrides[0].translations.en="Updated primary offer-free copy";
 const b=localizedFollowUpText({slot:2,originalText:"stale",customerTexts:["How much?"],
   treatmentInterest:"骨盆调理",clinicConfig:changed});
 assert.equal(a,"Primary pelvic English 2h");
 assert.equal(b,"Updated primary offer-free copy");
});


test("20h fallback uses primary treatment-specific customer language, never a Chinese default",()=>{
 const en=localizedFollowUpText({slot:20,originalText:"Secondary Chinese fallback",
  customerTexts:["Can I book an assessment for 9D?"],treatmentInterest:"9D 逆龄抗衰",clinicConfig:{
   ...liveClinic,automatedFollowUp:{...liveClinic.automatedFollowUp,
    additionalSteps:[liveClinic.automatedFollowUp.additionalSteps[0],{
     message:"Primary 20h Chinese",translations:{en:"Primary 20h English",zh:"Primary 20h Chinese",ms:"Primary 20h Malay"},
     serviceOverrides:[{serviceName:"9D 逆龄抗衰",translations:{en:"Primary 9D assessment English"}}],
    }],
   },
  }});
 assert.equal(en,"Primary 9D assessment English");
 assert.equal(localizedFollowUpText({slot:20,originalText:"Secondary Chinese fallback",customerTexts:["ok"],clinicConfig:liveClinic}),null);
});


test("explicit combined 3D + 9D enquiry selects the combo, not a single treatment",()=>{
 const combined={...liveClinic,
  services:[...liveClinic.services,{name:"3D + 9D 组合"},{name:"3D 小颜术"}],
  serviceAliases:[...liveClinic.serviceAliases,
   {alias:"3D",officialService:"3D 小颜术"},
   {alias:"3D + 9D",officialService:"3D + 9D 组合"},
   {alias:"9D+3D",officialService:"3D + 9D 组合"}],
  automatedFollowUp:{...liveClinic.automatedFollowUp,
   serviceOverrides:[...liveClinic.automatedFollowUp.serviceOverrides,
    {serviceName:"3D + 9D 组合",translations:{en:"Approved combined 3D+9D follow-up"}}]},
 };
 for(const msg of ["I want the 3D + 9D combo","I want both 3D and 9D",
  "我想3D和9D一起做","I prefer 9D+3D", "Nak buat 3D dan 9D"]){
  assert.equal(resolveFollowUpTreatment({clinicConfig:combined,
   customerTexts:[msg],treatmentInterest:"9D 逆龄抗衰"}),"3D + 9D 组合",msg);
 }
 assert.equal(localizedFollowUpText({slot:2,
  originalText:"Old text",customerTexts:["I want the 3D + 9D combo"],
  treatmentInterest:"9D 逆龄抗衰",clinicConfig:combined}),
  "Approved combined 3D+9D follow-up");
 for(const msg of ["Should I choose 3D or 9D?","What is the difference between 3D and 9D?",
  "3D还是9D哪个比较适合?"]){
  assert.equal(resolveFollowUpTreatment({clinicConfig:combined,
   customerTexts:[msg],treatmentInterest:"9D 逆龄抗衰"}),null,msg);
 }
});

test("Neutro #8943 retains verified pelvic context across package and branch questions",()=>{
 // Newest-first, sender-bound customer messages in the 24h follow-up context.
 // The previous five-message cutoff hid both explicit pelvic requests.
 const turns=[
  "哪一分行",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "那这种调理是做一次就行了吗？想了解价钱看看",
  "那这种调理是做一次就行了吗？想了解价钱看看",
  "我平时久坐，腰有点酸，小腹也比较突出。",
  "我对你们的骨盆调理有兴趣，想了解一下。",
  "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
 ];
 const config=structuredClone(liveClinic);
 config.automatedFollowUp.additionalSteps[0].serviceOverrides.push({
  serviceName:"骨盆调理",translations:{zh:"Pelvic-specific 6h reminder"},
 });
 assert.equal(resolveFollowUpTreatment({clinicConfig:config,
  customerTexts:turns,treatmentInterest:null}),"骨盆调理");
 for(const [slot,expected] of [[2,"Primary pelvic Chinese 2h"],
  [6,"Pelvic-specific 6h reminder"]]){
  assert.equal(localizedFollowUpText({slot,customerTexts:turns,
   treatmentInterest:null,clinicConfig:config}),expected);
 }
});

test("later explicit treatment switch overrides older verified pelvic context",()=>{
 const turns=["I now want 9D lift instead","哪一分行","我对你们的骨盆调理有兴趣"];
 assert.equal(resolveFollowUpTreatment({clinicConfig:liveClinic,
  customerTexts:turns,treatmentInterest:"骨盆调理"}),"9D 逆龄抗衰");
});

test("declined or mixed recent treatment enquiry must not inherit older video",()=>{
 for(const newest of ["I don't want pelvic care anymore",
  "我不想做骨盆调理了","Should I choose pelvic or 9D lift?"]){
  assert.equal(resolveFollowUpTreatment({clinicConfig:liveClinic,
   customerTexts:[newest,"我对骨盆调理有兴趣"],treatmentInterest:"骨盆调理"}),null,newest);
 }
});

test("explicitly declined 3D + 9D combo is not treated as consent for combo video",()=>{
 const config={...liveClinic,
  services:[...liveClinic.services,{name:"3D + 9D 组合"},{name:"3D 小颜术"}],
  serviceAliases:[...liveClinic.serviceAliases,
   {alias:"3D + 9D",officialService:"3D + 9D 组合"},
   {alias:"3D",officialService:"3D 小颜术"}],
 };
 assert.equal(resolveFollowUpTreatment({clinicConfig:config,
  customerTexts:["I don't want the 3D + 9D combo anymore","我想了解骨盆调理"],
  treatmentInterest:"3D + 9D 组合"}),null);
});

test("uncertainty about treatment is not misclassified as a refusal",()=>{
 for(const customer of ["I don't know how pelvic care works",
  "我不是很清楚骨盆调理是什么"]){
  assert.equal(resolveFollowUpTreatment({clinicConfig:liveClinic,
   customerTexts:[customer]}),"骨盆调理",customer);
 }
});

test("video and caption share the verified treatment even with an older ad enquiry",()=>{
 assert.equal(localizedFollowUpText({
  slot:6,customerTexts:["Where is your branch?","How much is 3D?"],
  treatmentInterest:"3D 小颜术",selectedTreatment:"9D 逆龄抗衰",
  clinicConfig:liveClinic,
 }),"Primary 9D English 6h");
 assert.equal(localizedFollowUpText({
  slot:2,customerTexts:["Where is your branch?","How much is pelvic care?"],
  treatmentInterest:"骨盆调理",selectedTreatment:null,
  clinicConfig:liveClinic,
 }),"Primary clinic English 2h");
});
