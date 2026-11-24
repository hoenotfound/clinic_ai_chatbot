"use strict";
// Manual-only secondary chats stay manual. Surface action-worthy messages
// instead of silently completing an inbound processing job without a reply.
const {isBreastLumpConcern}=require("./aiReviewPolicy");
const {isRm68ClinicalConcern}=require("./neutroRm68InterestEvidence");
function manualOnlySecondaryAttention(text){
 const value=String(text||"").trim();
 if(!value||value.length>1500)return null;
 const appointment=/(?:\b(?:appointment|book(?:ing)?|available\s+slots?|any\s+slots?|schedule|reschedul(?:e|ing)|visit\s+(?:today|tomorrow)|temujanji|slot\s+kosong)\b|预约|預約|约时间|約時間|有位|空位|能安排|可以安排)/iu.test(value);
 const breastConcern=isBreastLumpConcern(value)||
   /(?:乳腺癌|乳癌|胸(?:部|口)?(?:有)?(?:肿瘤|腫瘤|瘤)|breast\s+cancer)/iu.test(value)||
   (/(?:胸部|乳房|乳腺|breast|RM\s*68)/iu.test(value)&&isRm68ClinicalConcern(value));
 const health=breastConcern||
  /(?:\b(?:hurt\s+(?:my|the)|injur(?:y|ed)|sudden\s+pain|back\s+pain|severe\s+pain|breast\s+lump|lump|bleeding|numbness|tingling)\b|受伤|受傷|疼痛|突然痛|剧痛|劇痛|结节|結節|肿块|腫塊|麻痹|下背痛|腰痛)/iu.test(value);
 if(!appointment&&!health)return null;
 return {
  reason:health
   ?"Manual-only secondary WhatsApp: customer mentioned a health concern. Staff should review the latest message before discussing treatment."
   :"Manual-only secondary WhatsApp: customer asked about an appointment. Staff should check the latest message and availability.",
  kind:health?"health":"appointment",
 };
}
module.exports={manualOnlySecondaryAttention};
