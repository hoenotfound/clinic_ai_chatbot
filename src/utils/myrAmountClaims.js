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
// Distinguish payable prices from explicitly labelled normal prices and
// voucher face values. Scope labels to their adjacent amount, not the
// entire paragraph; a denial is not evidence of a positive quote.
const NEGATED_PRICE=/(?:\b(?:not|never|incorrect|wrong|isn['’]?t|aren['’]?t|wasn['’]?t|bukan|tidak|tak|salah)\b|不是|并非|並非|不对|不對|错误|錯誤|不等于|不等於|非优惠价|非優惠價)/iu;
const NORMAL_LABEL=/(?:原价|原價|正常价|正常價|(?:normal|original|regular|usual)\s+price|harga\s+(?:asal|biasa|normal))\s*[:：]?\s*$/iu;
const VOUCHER_LABEL=/(?:优惠券|優惠券|折扣券|折扣|抵用券|voucher|coupon|baucar|discount)\s*(?:worth|of|价值|價值|面额|面額)?\s*[:：]?\s*$/iu;
const VOUCHER_SUFFIX=/^\s*(?:的)?\s*(?:优惠券|優惠券|折扣券|抵用券|voucher|coupon|baucar|discount\b|off\b)/iu;
const NORMAL_SUFFIX=/^\s*[(（]?\s*(?:原价|原價|正常价|正常價|(?:normal|original|regular)\s+price|harga\s+(?:asal|biasa|normal))\s*[)）]/iu;
const AFTER_VOUCHER=/(?:优惠券后|優惠券後|优惠后|優惠後|(?:after|less)\s+(?:applying\s+)?(?:the\s+)?(?:voucher|coupon)|selepas\s+(?:guna\s+)?baucar)/iu;
function monetaryClaims(value){
  const text=normalizeMoneyText(value);
  const claims=scanMyrAmounts(text);
  return claims.map((claim,i)=>{
    const preceding=text.slice(i?claims[i-1].index+claims[i-1].raw.length:0,claim.index);
    const following=text.slice(claim.index+claim.raw.length,claims[i+1]?.index??text.length);
    const before=preceding.split(/[\n;；。!?！？]|\.(?!\d)/u).at(-1);
    const after=following.split(/[\n;；。!?！？]|\.(?!\d)/u)[0];
    const normal=NORMAL_LABEL.test(before)||NORMAL_SUFFIX.test(after);
    const voucher=VOUCHER_LABEL.test(before)||VOUCHER_SUFFIX.test(after);
    return {...claim,role:normal&&voucher?"unknown":normal?"normal":voucher?"voucher":"offer",
      negated:NEGATED_PRICE.test(before)||/^\s*(?:is\s+not|isn['’]?t|不是|不对|不對|bukan|tidak)\b/iu.test(after),
      afterVoucher:AFTER_VOUCHER.test(before)||AFTER_VOUCHER.test(after)};
  });
}
function configuredPackageMoney(item){
  const offer=item?.pricing?.offer;
  const normal=item?.pricing?.normal;
  if(!Number.isSafeInteger(offer)||offer<=0||item?.pricing?.currency!=="MYR")return null;
  const copies=[item.caption,...Object.values(item.mediaTranslations||{}).map(x=>typeof x==="string"?x:x?.caption)].filter(Boolean);
  const faceValues=copies.flatMap(copy=>monetaryClaims(copy).filter(c=>c.role==="voucher"&&!c.negated).map(c=>c.amount));
  const validNormal=Number.isSafeInteger(normal)&&normal>=offer?normal:null;
  const voucher=validNormal!==null&&validNormal>offer&&faceValues.length&&faceValues.every(x=>x===validNormal-offer)?validNormal-offer:null;
  return {offer,normal:validNormal,voucher,afterVoucher:voucher!==null||copies.some(copy=>AFTER_VOUCHER.test(copy)&&/(?:优惠券|優惠券|voucher|coupon|baucar)/iu.test(copy))};
}
function verifyPackageMoney(value,facts,{requireOffer=true}={}){
  const claims=monetaryClaims(value);
  if(!facts||!claims.length||NEGATED_PRICE.test(normalizeMoneyText(value)))return false;
  if(claims.some(c=>c.negated||c.amount===null||c.role==="unknown"||facts[c.role]!==c.amount||(c.afterVoucher&&!facts.afterVoucher)))return false;
  return !requireOffer||claims.some(c=>c.role==="offer");
}
module.exports={normalizeMoneyText,scanMyrAmounts,hasMyrAmount,monetaryClaims,configuredPackageMoney,verifyPackageMoney};
