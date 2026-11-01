"use strict";
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
// Last-resort copy correction: it never authorizes a price or media send.
const GENERIC = /^(?:请问你想了解哪(?:一)?项疗程的价格呢？(?:我可以帮你确认|我帮你确认)\s*😊?|Which treatment would you like the price for\? I can help (?:you )?check\s*😊?|Harga untuk rawatan yang mana satu ya\?.*)$/iu;
const STAFF = /^\[Verified STAFF message\]/u;
const TWO = /\b3\s*d\b.*(?:和|与|及|、|and|&)\s*9\s*d\b|\b9\s*d\b.*(?:和|与|及|、|and|&)\s*3\s*d\b/iu;
function improveRepeatedPriceClarification({
 customerText,reply,conversationHistory=[],services=[],serviceAliases=[],language="zh",
}={}) {
 const original=String(reply||"");
 if(!GENERIC.test(original.trim()))return {reply:original,changed:false};
 const history=Array.isArray(conversationHistory)?conversationHistory.slice(-12):[];
 if(!history.some(t=>t?.role==="assistant"&&GENERIC.test(String(t.content||"").trim())) ||
   history.some(t=>t?.pricingStaffAuthored===true||
     (t?.role==="assistant"&&STAFF.test(String(t.content||"")))))
   return {reply:original,changed:false};
 const customerTurns=history.filter(t=>t?.role==="user").slice(-4);
 if(!(hasExplicitPriceRequest(customerText)||
      customerTurns.some(t=>hasExplicitPriceRequest(t.content))))
   return {reply:original,changed:false};
 let chosen=safeServiceFromCustomer(customerText,services,serviceAliases);
 if(!chosen) {
  const earlier=customerTurns.map(t=>safeServiceFromCustomer(t.content,services,serviceAliases)?.name).filter(Boolean);
  if(new Set(earlier).size===1)chosen=services.find(s=>s.name===earlier[0])||null;
 }
 const two=!chosen&&TWO.test(String(customerText||""))&&
   !/(?:组合|組合|combo|combination|套餐|配套|[+＋])/iu.test(customerText);
 if(!chosen&&!two)return {reply:original,changed:false};
 const label=two?"3D 小颜术和9D 逆龄抗衰":chosen.name;
 const locale=String(language||"").toLowerCase();
 const message=locale.startsWith("en")
   ?"You've already specified "+label+". I can't verify its current price, so the centre needs to confirm the accurate amount."
   :locale.startsWith("ms")
     ?"Anda sudah nyatakan "+label+". Saya belum dapat sahkan harga terkini; pihak pusat perlu mengesahkan jumlah yang tepat."
     :"明白，你已经说明想了解"+label+"的价格了 😊 我这边暂时无法核对准确金额，需要由门店同事确认，避免给错报价。";
 return {reply:message,changed:true};
}
module.exports={improveRepeatedPriceClarification};
