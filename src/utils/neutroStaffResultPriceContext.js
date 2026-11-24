"use strict";

// A delivered staff result image may continue a customer's already named
// treatment. It cannot establish a new treatment, consent or medical advice.
const {serviceCandidates,findServicesInText}=require("./conversationPromptContext");
const {safeServiceFromCustomer}=require("./initialOfferReplyGuard");
const {hasExplicitPriceRequest}=require("./customerEnquiryEvidence");
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const {pricingMessageText,isVerifiedStaffTurn,isRecentPricingThread,
 assistantIntroducesCompetingPaidService}=require("./priceFollowUpContext");
const SHORT_PRICE=/^(?:(?:请问|請問|想问|想問)\s*)?(?:(?:这个|這個|这项|這項|这种|這種|这個|這个|疗程|療程|护理|護理|体验|體驗)\s*)?(?:多少钱|多少錢|几多钱|幾多錢|价钱|價錢|价格|價格|收费多少|收費多少|费用多少|費用多少)(?:呢|啊|呀|吗|嗎)?[\s?？。!！]*$|^(?:how much(?: (?:is|for) (?:this|that|it))?|(?:the )?price(?: please)?|berapa(?: harga)?(?: (?:ini|ni|rawatan ini))?|harga(?: berapa)?)[\s?？.!！]*$/iu;
const THIS=/^(?:这个|這個|这项|這項|这种|這種|this(?: one)?|that(?: one)?|yang ini|yang ni|ini)[\s?？。!！.]*$/iu;
const ASK_WHICH=/(?:哪.{0,24}(?:疗程|療程|护理|護理).{0,24}(?:价格|價格|价钱|價錢|多少钱|多少錢)|(?:哪.{0,24}(?:价格|價格|价钱|價錢))|\bwhich\b.{0,45}\b(?:treatment|service|price)\b|\brawatan\b.{0,20}\bmana\b)/iu;
const RESULT_CAPTION=/(?:before\s*(?:&|and|\/|＆)\s*after|前后对比|前後對比)/iu;
const STOP=/(?:不要|不想|不需要|停止|退订|退訂|改做|改选|改選|换个|換個|另外|其他疗程|其他療程|所有疗程|所有療程|押金|订金|訂金|退款|\b(?:stop|unsubscribe|opt\s*out|switch|instead|another|refund|deposit|don't want|not interested|tak nak|tidak mahu)\b)/iu;
const MONEY=/(?:RM\s*\d|MYR\s*\d|价格|價格|价钱|價錢|收费|收費|优惠|優惠|折扣|price|cost|harga)/iu;
const stripStaff=s=>s.replace(/^\[Verified STAFF message\]\s*/u,"").trim();

function resolveStaffResultPriceContext({customerText,conversationHistory=[],services=[],serviceAliases=[],now=Date.now()}={}){
 const current=String(customerText||"").trim();
 if(!current||!Number.isFinite(now)||STOP.test(current)||hasClinicalMediaRisk(current))return null;
 const turns=Array.isArray(conversationHistory)?conversationHistory:[];
 const last=turns.at(-1);
 if(last?.role!=="user"||pricingMessageText(last).trim()!==current)return null;
 let requestIndex=turns.length-1;
 if(THIS.test(current)){
   const question=turns.at(-3),clarification=turns.at(-2);
   if(question?.role!=="user"||clarification?.role!=="assistant"||
     isVerifiedStaffTurn(clarification)||!ASK_WHICH.test(pricingMessageText(clarification))||
     !SHORT_PRICE.test(pricingMessageText(question).trim())||
     last.pricingCreatedAtMs-question.pricingCreatedAtMs>10*60*1000)return null;
   requestIndex-=2;
 }else if(!SHORT_PRICE.test(current)||!hasExplicitPriceRequest(current))return null;
 const before=turns.slice(0,requestIndex);
 const index=before.findLastIndex(t=>t?.role==="user");
 if(index<0||!isRecentPricingThread(turns,index,now))return null;
 const chosenText=pricingMessageText(before[index]).trim();
 if(!chosenText||STOP.test(chosenText)||hasClinicalMediaRisk(chosenText))return null;
 const candidates=serviceCandidates(services,serviceAliases);
 const selected=safeServiceFromCustomer(chosenText,services,serviceAliases);
 const names=[...new Set(findServicesInText(chosenText,candidates))];
 // Require the customer's exact configured service name, not an ad,
 // staff suggestion, symptom or model inference.
 const normalize=v=>String(v||"").normalize("NFKC").replace(/\s+/gu,"").toLowerCase();
 if(!selected||names.length!==1||names[0]!==selected.name||
    normalize(chosenText)!==normalize(selected.name))return null;
 let matchedImage=false,botAcknowledged=false;
 for(const turn of before.slice(index+1)){
   if(turn.role!=="assistant")return null;
   const caption=stripStaff(pricingMessageText(turn));
   if(isVerifiedStaffTurn(turn)){
     // Coexistence's deleted/unsupported echo has no usable content.
     // Ignore ONLY authenticated system placeholders before the later
     // delivered same-treatment staff image, never actual staff text.
     if(turn.pricingBusinessAppPlaceholder===true&&!matchedImage)continue;
     if(matchedImage||turn.pricingDeliveredStaffImage!==true||
       !RESULT_CAPTION.test(caption)||STOP.test(caption)||MONEY.test(caption)||
       hasClinicalMediaRisk(caption))return null;
     const refs=[...new Set(findServicesInText(caption,candidates))];
     if(refs.length!==1||refs[0]!==selected.name)return null;
     matchedImage=true;
   }else{
     if(STOP.test(caption)||assistantIntroducesCompetingPaidService(turn,selected.name,candidates))return null;
     if(findServicesInText(caption,candidates).includes(selected.name))botAcknowledged=true;
   }
 }
 if(!matchedImage||!botAcknowledged)return null;
 // A quoted price/amount is not inferred from the caption. Require an
 // explicit fresh customer price request; actual offer comes from config.
 return {name:selected.name,priceText:pricingMessageText(turns[requestIndex]).trim()};
}
module.exports={resolveStaffResultPriceContext};
