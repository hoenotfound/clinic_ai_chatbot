"use strict";
// Only the customer's readable current message is evidence, never the ad.
function isExplicitRm68Interest(value){
 const text=String(value||"").normalize("NFKC").replace(/\s+/gu," ").trim();
 if(!text||text.length>900)return false;
 return /\b(?:RM|MYR)\s*68\b/iu.test(text) &&
   /(?:胸部|乳腺|乳房|breast|payudara)/iu.test(text) &&
   /(?:我对|我對|想了解|想问|想問|请问|請問|有兴趣|有興趣|interested|berminat|nak\s+tahu|want\s+to\s+know|can\s+i\s+book)/iu.test(text) &&
   !/(?:不感兴趣|不感興趣|不想了解|不要这个|不要這個|退订|退訂|stop\s+promotion|not\s+interested)/iu.test(text);
}
module.exports={isExplicitRm68Interest};