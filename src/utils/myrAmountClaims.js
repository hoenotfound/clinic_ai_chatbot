"use strict";

// One monetary parser for reply validation. Normalise full-width and keycap
// digits; accept only complete MYR amounts. A malformed amount is a claim,
// not absence of a claim. Chinese text can directly precede the currency.
function normalizeMoneyText(value){
  return String(value??"").normalize("NFKC").replace(/[\uFE0F\u20E3]/gu,"");
}
function scanMyrAmounts(value){
  const text=normalizeMoneyText(value);
  return [...text.matchAll(/(?<![a-z0-9])(?:MYR|RM|马币|馬幣|令吉)\s*([+-]?\s*\d(?:[\d,.]*\d)?)/giu)].map(match=>{
    const raw=match[1].trim();
    const valid=/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/u.test(raw);
    const suffix=text.slice(match.index+match[0].length);
    // Do not interpret a range, arithmetic expression or magnitude shorthand
    // as the approved single price (e.g. RM68-100, RM68k, RM68 + 20).
    const compound=/^\s*(?:[-–—~～+＋至到/]\s*\d|(?:to|hingga)\s+\d|(?:k|m|b|thousand|million|billion)\b|[千万萬亿億])/iu.test(suffix);
    const amount=valid&&!compound?Number(raw.replace(/,/gu,"")):NaN;
    return {raw:match[0],index:match.index,amount:Number.isFinite(amount)&&amount<=Number.MAX_SAFE_INTEGER?amount:null};
  });
}
function hasMyrAmount(value,amount){
  return scanMyrAmounts(value).some(claim=>claim.amount===amount);
}
module.exports={normalizeMoneyText,scanMyrAmounts,hasMyrAmount};
