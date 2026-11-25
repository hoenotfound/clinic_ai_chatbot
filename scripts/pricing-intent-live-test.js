"use strict";
// Focused, synthetic pricing A/B. Offline by default. Never starts the
// server, writes to Neon, sends customer messages or uses production keys.
const { GoogleGenAI }=require("@google/genai");
const config=require("../src/config/clinicConfig");
const {getIndustryProfile,hydrateBusinessConfig}=require("../src/config/industryProfiles");
const {buildGeminiRequest}=require("../src/services/geminiService");
const {parseAiReplyResult}=require("../src/utils/aiReplyResult");
const {resolveAiPricingDecision,resolveModelLedPricingDecision,shouldApplyModelLedPricing,shouldBlockRejectedModelPricing}=require("../src/utils/aiPricingIntentDecision");
const {resolveApprovedPricingAssessment}=require("../src/utils/approvedPricingDecision");
const {usageOf}=require("./neutro-ab");
const MODEL="gemini-3.8-flash";
const services=[{name:"3D 小颜术",description:"Facial contour care"},
 {name:"9D 逆龄抗衰",description:"Facial care"},{name:"骨盆调理",description:"Pelvic and posture care"}];
const serviceAliases=[{alias:"3D",officialService:"3D 小颜术"},
 {alias:"9D",officialService:"9D 逆龄抗衰"},{alias:"Pelvic Care",officialService:"骨盆调理"}];
const single=(service,amount)=>({name:service+" First Trial",linkedService:service,
 sendOnPriceQuery:true,validFrom:"2000-01-01",validUntil:"2999-12-31",
 imageUrl:"https://example.test/"+amount,caption:"First Trial RM"+amount,pricing:{currency:"MYR",offer:amount}});
const promotions=[single("3D 小颜术",388),single("9D 逆龄抗衰",488),
 {...single("骨盆调理",388),packages:[{name:"Package A",imageUrl:"https://example.test/a",
 caption:"First Trial RM388",pricing:{currency:"MYR",offer:388}},
 {name:"Package B",imageUrl:"https://example.test/b",caption:"First Trial RM268",pricing:{currency:"MYR",offer:268}}]}];
const u=content=>({role:"user",content}),a=content=>({role:"assistant",content});
const context=name=>[u(name),a(name+" is a service available at our centre.")];
const scenarios=[
 ["zh-multi-turn","zh",[...context("骨盆调理"),u("一次有效吗？"),a("每个人情况不同哦。"),u("那我要准备多少预算呢？")],"骨盆调理",["RM388","RM268"]],
 ["en-novel-price","en",[...context("3D 小颜术"),u("What would I be paying?")],"3D 小颜术",["RM388"]],
 ["ms-novel-price","ms",[...context("9D 逆龄抗衰"),u("Berapa perlu saya sediakan?")],"9D 逆龄抗衰",["RM488"]],
 ["zh-cheaper-package","zh",[u("骨盆调理"),a("骨盆调理\nPackage A: RM388\nPackage B: RM268"),u("比较便宜的那个多少钱？")],"骨盆调理",["RM268"]],
 ["en-specific-package","en",[...context("Pelvic Care"),u("What would I pay for Package B?")],"骨盆调理",["RM268"]],
 ["ms-package-enquiry","ms",[...context("Pelvic Care"),u("Pakej apa yang ada?")],"骨盆调理",["RM388","RM268"]],
 ["zh-service-change","zh",[...context("3D 小颜术"),u("不是3D，我想了解9D的价钱")],"9D 逆龄抗衰",["RM488"]],
 ["zh-effectiveness","zh",[...context("3D 小颜术"),u("一次有效吗？")],null,[]],
 ["en-duration","en",[...context("3D 小颜术"),u("How much time does this take?")],null,[]],
 ["ms-future-consent","ms",[...context("Pelvic Care"),u("Kalau ada promosi nanti, beritahu saya ya")],null,[]],
 ["en-price-objection","en",[...context("3D 小颜术"),u("That's too expensive")],null,[]],
 ["zh-ambiguous","zh",[u("3D和9D"),a("我们都有3D小颜术和9D逆龄抗衰。"),u("这个多少钱？")],null,[]],
 ["zh-later-session","zh",[u("3D 小颜术"),a("First Trial RM388"),u("第一次体验之后多少钱？")],null,[]],
];
function withConfig(mode,fn){
 const previous={...config};
 try{
  for(const k of Object.keys(config))delete config[k];
  Object.assign(config,hydrateBusinessConfig({...getIndustryProfile("tcm_clinic"),
   businessName:"Synthetic Pricing Test Centre",services,serviceAliases,promotions,
   aiPricingIntentMode:mode,aiPricingOfferEnquiriesEnabled:true,
   automatedFollowUp:{assessmentFirstPricingEnabled:true,complimentaryAssessmentExperienceEnabled:true}}));
  return fn();
 }finally{
  for(const k of Object.keys(config))delete config[k];
  Object.assign(config,previous);
 }
}
async function main(){
 const live=process.argv.includes("--live");
 const key=live?process.env.NEUTRO_AB_GEMINI_API_KEY:null;
 if(live&&!key)throw new Error("Set a separate authorized NEUTRO_AB_GEMINI_API_KEY in the local shell.");
 const ai=live?new GoogleGenAI({apiKey:key}):null;
 const results=[];
 const requested=process.argv.filter(arg=>arg.startsWith("--scenario=")).map(arg=>arg.slice(11));
 const selectedScenarios=scenarios.filter(([id])=>!requested.length||requested.includes(id));
 if(!selectedScenarios.length || requested.some(id=>!scenarios.some(s=>s[0]===id)))throw new Error("Unknown test scenario.");
 for(const [index,[id,lang,history,treatment,amounts]] of selectedScenarios.entries()){
  const row={id,expected:{treatment,amounts}};
  for(const mode of index%2?["enabled","shadow"]:["shadow","enabled"]){
   const request=withConfig(mode,()=>buildGeminiRequest(history,
    {surface:"conversation",channel:"whatsapp",replyLanguage:lang,isFirstMessage:false},MODEL).request);
   row[mode]={promptChars:request.config.systemInstruction.length};
   if(!live)continue;
   let stage="provider",responseText=null,finishReason=null;
   try{
    const response=await ai.models.generateContent(request);
    stage="usage";
    row[mode].usage=usageOf(response);
    finishReason=response.candidates?.[0]?.finishReason??null;
    stage="response_text";
    responseText=response.text;
    stage="parser";
    const result=withConfig(mode,()=>parseAiReplyResult(responseText));
    stage="pricing_validation";
    const now=Date.now();
    const historyWithTimes=history.map((t,i)=>({...t,pricingCreatedAtMs:now-(history.length-1-i)*1000}));
    const args={customerText:history.at(-1).content,conversationHistory:historyWithTimes,
     services,serviceAliases,promotions,allowOfferEnquiries:true,
     complimentaryAssessmentExperienceEnabled:true,now};
    const modelIntent={structured:result.structured,outcome:result.outcome,priceQuery:result.priceQuery,
     packageQuery:result.packageQuery,treatment:result.details?.treatment,
     promotionOption:result.promotionOption,pricingStage:result.pricingStage};
    const old=resolveAiPricingDecision({...args,...modelIntent});
    const semantic=resolveModelLedPricingDecision({...args,modelIntent});
    const approve=(d,approvalMode="enabled")=>resolveApprovedPricingAssessment({...args,mode:approvalMode,aiDecision:d,
     flagged:result.flagged,bookingReady:result.bookingReady});
    // These are offline candidate comparisons, not a simulation of every
    // server special case or a provider delivery test.
    const oldApproved=approve(old),semanticApproved=approve(semantic);
    const legacyApproval=approve(old,mode);
    const applied=shouldApplyModelLedPricing({mode,legacyCandidate:old,legacyApproval,semanticApproval:semanticApproved});
    const rejected=shouldBlockRejectedModelPricing({mode,modelIntent,semanticCandidate:semantic,
     semanticApproval:semanticApproved,legacyApproval,customerText:args.customerText,promotions});
    const selected=rejected?null:(applied?semanticApproved.decision:legacyApproval.decision);
    const project=d=>({treatment:d?.treatment??null,amounts:d?.prices?.map(p=>p.price)||[]});
    const matches=d=>JSON.stringify(project(d))===JSON.stringify({treatment,amounts});
    row[mode]={...row[mode],modelIntent,reply:result.text,legacy:project(oldApproved.decision),
     semantic:project(semanticApproved.decision),semanticMatch:matches(semanticApproved.decision),
     approvalReasons:{legacy:oldApproved.reason,semantic:semanticApproved.reason},
     ordinaryPathSelection:{applied,rejected,...project(selected),matchesExpected:matches(selected)}};
    // This comparison does not include protected server exceptions, text
    // formatting, language correction, sender policy, or actual delivery.
   }catch(err){
    row[mode].error="Provider/parser failed; no application retry";
    row[mode].errorDetails={stage,name:String(err?.name||"Error"),
     code:err?.code==="INVALID_AI_RESPONSE"?"INVALID_AI_RESPONSE":null,
     status:Number.isInteger(err?.status)?err.status:null,finishReason};
    // Only the synthetic model output and known parser messages are safe
    // diagnostics. Never dump SDK request objects, headers or API keys.
    if(stage==="parser"){
     row[mode].errorDetails.message=err?.code==="INVALID_AI_RESPONSE"?String(err.message).slice(0,300):null;
     row[mode].errorDetails.syntheticResponse=typeof responseText==="string"?responseText.slice(0,4000):null;
    }
   }
  }
  results.push(row);
 }
 const report=JSON.stringify({live,model:MODEL,scenarios:results.length,
  providerCallLimit:live?results.length*2:0,results},null,2);
 const output=process.argv.find(arg=>arg.startsWith("--output="))?.slice(9);
 if(output){require("node:fs").writeFileSync(output,report+"\n","utf8");console.log("Report written to "+output);}
 else console.log(report);
}
if(require.main===module)main().catch(err=>{console.error(err.message);process.exitCode=1;});
