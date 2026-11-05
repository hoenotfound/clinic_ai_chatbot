"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const config=require("../src/config/clinicConfig");
const {buildSystemPrompt}=require("../src/utils/systemPrompt");
const {buildScopedReplyPrompt}=require("../src/utils/scopedReplyPrompt");
test("baseline and shorter treatment prompts preserve all non-knowledge sections",()=>{
 const backup={...config};
 try{
 Object.assign(config,{businessName:"Neutro Sense TCM Centre",businessType:"tcm_clinic",
 services:[{name:"3D Face",description:"Face",duration:"1 hour",priceRange:"RM500"},{name:"9D Face",description:"Face",duration:"2 hours",priceRange:"RM600"}],
 faqs:[{q:"Hours?",a:"Ask staff"},{q:"3D Face questions?",a:"3D Face details"},{q:"9D Face questions?",a:"9D Face details"}],
 guardrails:["Never invent bookings","For 3D Face do not invent details","For 9D Face do not invent details"]});
 const report=[];
 for(const [topic,expectedShorter] of [["3D Face",true],["9D Face",true],["",false]]){
 const o={surface:"conversation",channel:"whatsapp",conversationContext:{
 relevantServiceNames:topic?[topic]:[],currentCustomerText:topic,promotionIntent:false}};
 const oldText=buildSystemPrompt(o),newText=buildScopedReplyPrompt(o);
 assert.equal(newText.split("BUSINESS INFO:")[1],oldText.split("BUSINESS INFO:")[1]);
 assert.equal(newText.length<oldText.length,expectedShorter);
 report.push({topic:topic||"unknown",old:oldText.length,optimized:newText.length});
 }
 console.log("NEUTRO_SIDE_BY_SIDE "+JSON.stringify(report));
 }finally{for(const k of Object.keys(config))delete config[k];Object.assign(config,backup);}
});
