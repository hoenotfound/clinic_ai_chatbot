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
const normalize=v=>String(v||"").normalize("NFKC").replace(/[^\p{L}\p{N}+&]+/gu,"").toLowerCase();
// Accept a whole configured name/alias with a conventional interest phrase,
// not a service mention embedded in a discussion, refusal or comparison.
function isCustomerSelection(text,selected,candidates){
 const body=text.normalize("NFKC").trim()
   .replace(/^(?:(?:您好|你好|hello|hi)[,，!！\s]*)?/iu,"")
   .replace(/^(?:(?:我)?\s*(?:想(?:要)?(?:了解|知道|做|体验|體驗|问|問)|要(?:做|了解)|对|對)\s*|(?:i\s*(?:would like to know about|want to know about|would like to try|want to try|am interested in|'m interested in|would like|want))\s+|(?:saya\s+)?(?:nak tahu|mahu tahu|nak cuba|mahu cuba|berminat dengan|berminat|nak|mahu)\s+)/iu,"")
   .replace(/(?:\s*(?:有兴趣|有興趣|的详情|的詳情|了解一下|一下|please|ya))?[\s。.!！?？]*$/iu,"").trim();
 const terms=candidates.find(c=>c.name===selected.name)?.terms||[];
 return normalize(body)===normalize(selected.name)||
   terms.some(t=>normalize(t.key)===normalize(body));
}
const CHOICE_MENU=/(?:package\s*[a-z]|配套\s*[a-z]|套餐\s*[a-z]|(?:两个|兩個|两种|兩種|两项|兩項|多种|多種|其他|其它|或者|还是|還是|任选|任選|选项|選項|分别|分別)|\b(?:both|either|options?|alternatives?|another|other|or|dua|atau|pilihan)\b|(?:^|\n)\s*\d+[.)、])/iu;
const GENERIC_CLARIFICATION=/^(?:(?:请问|請問|你好|您好)[,，\s]*)?(?:你|您)?\s*(?:想|要)?\s*(?:了解|知道|问|問|看)?\s*哪(?:一)?(?:项|項|个|個|种|種)?\s*(?:疗程|療程|护理|護理|服务|服務)?\s*(?:的)?\s*(?:价格|價格|价钱|價錢|多少钱|多少錢)[\s呢呀啊吗嗎?？。!！]*(?:我可以帮你确认[\s😊☺️。!！]*)?$|^(?:which (?:treatment|service)(?:'s)? (?:price|cost)(?: would you like to know)?|which (?:treatment|service) (?:would you like|are you asking) (?:the )?(?:price|cost)(?: of| for)?|harga rawatan mana(?: yang anda ingin tahu)?|rawatan mana(?: yang anda nak tahu harga)?)[\s?？.!！]*$/iu;
const ECHO_MAX_MS=10_000;
const UNSUPPORTED="[unsupported sent from WhatsApp Business App]";
const DELETED="🗑️ [Message deleted from WhatsApp Business App]";

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
 const candidates=serviceCandidates(services,serviceAliases);
 // A demonstrative can answer only a single generic price clarification.
 // Even one named treatment or a package/menu in that question could change
 // the referent: never infer the earlier service from "this" in that case.
 if(requestIndex!==turns.length-1){
   const clarification=pricingMessageText(turns.at(-2)).trim();
   if(!GENERIC_CLARIFICATION.test(clarification)||CHOICE_MENU.test(clarification)||
      findServicesInText(clarification,candidates).length)return null;
 }
 const before=turns.slice(0,requestIndex);
 const index=before.findLastIndex(t=>t?.role==="user");
 if(index<0||!isRecentPricingThread(turns,index,now))return null;
 const chosenText=pricingMessageText(before[index]).trim();
 if(!chosenText||STOP.test(chosenText)||hasClinicalMediaRisk(chosenText))return null;
 const selected=safeServiceFromCustomer(chosenText,services,serviceAliases);
 const names=[...new Set(findServicesInText(chosenText,candidates))];
 // A fresh, unambiguous customer selection must be an exact configured
 // name or alias, optionally with a conventional interest phrase.
 if(!selected||names.length!==1||names[0]!==selected.name||
    !isCustomerSelection(chosenText,selected,candidates))return null;
 // Preserve clinical context anywhere in the trusted current 24h window.
 if(turns.some(t=>t.role==="user"&&Number.isFinite(t.pricingCreatedAtMs)&&
   t.pricingCreatedAtMs>=now-24*3600000&&hasClinicalMediaRisk(pricingMessageText(t))))return null;
 let matchedImage=false,botAcknowledged=false,ackAt=null,echoStart=null,echoCount=0,echoDeletes=0,echoClosed=false;
 for(const turn of before.slice(index+1)){
   if(turn.role!=="assistant")return null;
   const caption=stripStaff(pricingMessageText(turn));
   if(isVerifiedStaffTurn(turn)){
     // Only a compact, contiguous unsupported-then-deleted echo burst
     // immediately after the bot's same-service acknowledgement is eligible.
     // An isolated deletion, a second unsupported send, later app activity,
     // or intervening human text is not evidence of harmless continuity.
     if(turn.pricingBusinessAppPlaceholder===true){
       if(matchedImage||echoClosed||!botAcknowledged||ackAt==null||
          turn.pricingCreatedAtMs-ackAt>ECHO_MAX_MS||echoCount>=5)return null;
       if(echoCount===0){
         if(caption!==UNSUPPORTED)return null;
         echoStart=turn.pricingCreatedAtMs;
       }else{
         if(caption!==DELETED||turn.pricingCreatedAtMs-echoStart>ECHO_MAX_MS)return null;
         echoDeletes++;
       }
       echoCount++;
       continue;
     }
     if(echoCount&&!echoDeletes)return null;
     echoClosed=true;
     if(matchedImage||turn.pricingDeliveredStaffImage!==true||
       !RESULT_CAPTION.test(caption)||STOP.test(caption)||MONEY.test(caption)||
       hasClinicalMediaRisk(caption))return null;
     const refs=[...new Set(findServicesInText(caption,candidates))];
     if(refs.length!==1||refs[0]!==selected.name)return null;
     matchedImage=true;
   }else{
     if(echoCount&&!echoDeletes)return null;
     if(echoCount)echoClosed=true;
     if(STOP.test(caption)||hasClinicalMediaRisk(caption)||
        assistantIntroducesCompetingPaidService(turn,selected.name,candidates))return null;
     // A later menu can change what "this" or even a bare price means.
     // Reject actual alternative packages/treatments, not ordinary
     // explanatory questions about concerns or appointment arrangements.
     if(/(?:package\s*[ab]|配套\s*[ab]|套餐\s*[ab]|(?:^|\n)\s*\d+[.)、])/iu.test(caption))return null;
     if(findServicesInText(caption,candidates).includes(selected.name)){
       if(!matchedImage){botAcknowledged=true;ackAt=turn.pricingCreatedAtMs;}
     }
   }
 }
 if(!matchedImage||!botAcknowledged||(echoCount&&!echoDeletes))return null;
 // A quoted price/amount is not inferred from the caption. Require an
 // explicit fresh customer price request; actual offer comes from config.
 return {name:selected.name,priceText:pricingMessageText(turns[requestIndex]).trim()};
}
module.exports={resolveStaffResultPriceContext};
