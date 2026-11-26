"use strict";
const {scanMyrAmounts,normalizeMoneyText,monetaryClaims,verifyPackageMoney}=require("./myrAmountClaims");
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const {clearReplyLanguageMismatch}=require("./replyLanguageGuard");

// A deliberately bounded fact contract for existing independently approved
// special decisions. This module never selects a service, books, escalates
// or grants media permission. Unproven drafts retain the verified fallback.
const neutral=/^(?:hi|hello|dear|yes|sure|of course|thank you|thanks|hai|helo|baik|boleh|terima kasih|您好|你好|亲爱的|親愛的|好的|可以的|当然可以|當然可以|谢谢|謝謝)$/iu;
function comparable(value){
  return normalizeMoneyText(value).replace(/[😊☺🙂💕❤️💗💖🙏]/gu,"")
    .replace(/\s+/gu," ").trim().toLowerCase();
}
function harmlessLine(value){
  return neutral.test(comparable(value).replace(/^[\s,.!！。]+|[\s,.!！。]+$/gu,""));
}
// Only equivalent complete monetary tokens may be normalized. Never strip
// meaningful punctuation, negatives, conditions, dates, or numbers.
function canonicalMoney(value){
  let text=comparable(value);
  const claims=scanMyrAmounts(text);
  if(claims.some(c=>c.amount===null))return null;
  for(const claim of claims.reverse()){
    text=text.slice(0,claim.index)+"rm"+claim.amount+text.slice(claim.index+claim.raw.length);
  }
  return text;
}
function stripDecoration(value){
  return value.replace(/^[\s•●▪✅]+/gu,"").replace(/[。.!！\s]+$/gu,"").trim();
}
function equivalentFactText(value){
  const normalized=canonicalMoney(value);
  return normalized===null?null:stripDecoration(normalized);
}
function comparableLines(value){
  return String(value||"").split(/\r?\n/u).map(s=>s.trim()).filter(Boolean);
}
function verifiedEquivalentReply(draft,reference){
  const lines=comparableLines(draft).filter(line=>!harmlessLine(line));
  const baseline=comparableLines(reference);
  const actual=lines.map(equivalentFactText);
  const expected=baseline.map(equivalentFactText);
  return actual.length===expected.length&&actual.every((line,i)=>line!==null&&line===expected[i]);
}
// Recognize a small set of *claims*, rather than a complete prescribed
// sentence. Unknown conditions, medical assertions and extra amounts still
// fail closed. Courtesy, currency presentation and order are not facts.
const comboLabel=/(?:3\s*d\s*(?:[+＋&]|and|dan|和|与|與|及)\s*9\s*d|9\s*d\s*(?:[+＋&]|and|dan|和|与|與|及)\s*3\s*d)/iu;
const comboWords=/(?:\b(?:combo|combination|combined|together|bundle|kombo|gabungan|bersama|sekaligus)\b|组合|組合|一起|搭配)/iu;
const scopeNegation=/(?:\b(?:not|never|without|instead|bukan|tidak|tak)\b|不是|并非|並非|不要|不含|不包括)/iu;
const giftClaim=/(?:\b(?:complimentary|free)\s+(?:one[ -]hour|1[ -]hour|60[ -]minute)\s+meridian\s+(?:point\s+)?massage\b|\b(?:urutan meridian percuma selama (?:1|satu) jam|urutan meridian (?:1|satu) jam percuma|percuma urutan meridian (?:1|satu) jam)\b|(?:免费送|免費送|赠送|贈送|另送|还送|還送|送)(?:你|您)?\s*(?:1|一)\s*(?:小时|小時)(?:全身)?经络(?:穴位)?按摩|(?:免费送|免費送|赠送|贈送|另送|还送|還送|送)(?:你|您)?\s*(?:1|一)\s*(?:小时|小時)(?:全身)?經絡(?:穴位)?按摩)/giu;
const suitabilityClaim=/(?:\b(?:our|the) practitioner (?:can|will|needs to) (?:first )?assess (?:whether both treatments are suitable(?: together)?|suitability(?: first)?|your suitability(?: first)?)\b|\b(?:pengamal (?:akan|boleh|perlu) (?:semak|menilai) kesesuaian(?: dahulu)?|kesesuaian rawatan bersama akan dinilai oleh pengamal dahulu)\b|(?:是否适合一起安排[，, ]*)?(?:还是)?(?:需要)?先?(?:让|讓)?中[医醫]师(?:会|會)?先?(?:评估|評估)(?:是否适合一起安排|是否適合一起安排|是否适合|是否適合)?(?:哦|呀|呢)?)/giu;
function removeCourtesy(value){
  return value.replace(/^(?:hi|hello|dear|sure|of course|yes|hai|baik|boleh|您好|你好|亲爱的|親愛的|好的|可以的|当然可以|當然可以)[\s,!！。:：]+/iu,"").trim();
}
function comboPriceClauseMatches(value,decision){
  if(!decision||decision.treatment!=="3D + 9D 组合"||decision.afterVoucher||decision.mode==="contextual")return false;
  const money=monetaryClaims(value);
  if(money.length!==1||money[0].role!=="offer"||money[0].negated||money[0].afterVoucher||
    money[0].amount!==Number(String(decision.price).replace(/^RM/u,"")))return false;
  let text=removeCourtesy(comparable(value));
  if(scopeNegation.test(text)||!comboLabel.test(text)||!comboWords.test(text)||/[?？]/u.test(text))return false;
  const gifts=[...text.matchAll(giftClaim)];
  if(gifts.length>1||gifts.length&&!decision.complimentaryMeridianHour)return false;
  // Remove only independently verified optional claims. A different gift,
  // session duration, voucher, guarantee, or treatment leaves residual text.
  text=text.replace(giftClaim," ").replace(suitabilityClaim," ");
  const amount=scanMyrAmounts(text)[0];
  if(!amount)return false;
  text=text.slice(0,amount.index)+" "+text.slice(amount.index+amount.raw.length);
  text=text.replace(comboLabel," ");
  // Only connective language may remain; no free-text factual claim is
  // authorized by this check. Multiple treatment amounts are checked below.
  const words=/\b(?:if|you'd|you’re|youre|you|would|like|to|experience|try|both|treatments?|together|our|the|current|currently|now|combo|combination|combined|offer|bundle|promotional|promo|price|is|are|at|for|only|just|also|have|has|we|can|there's|there|with|and|a|ya|hai|kami|ada|harga|promosi|pakej|kombo|gabungan|kedua|dua|rawatan|sekarang|ialah|adalah|hanya|untuk|jika|anda|berminat|bersama|sekaligus|termasuk|dan|ini|boleh|juga)\b/giu;
  const zh=/(?:如果|假如|亲爱的|親愛的|您好|你好|你|您|想|要|两项|兩項|两个|兩個|都|体验价|體驗價|体验|體驗|一起|做|护理|護理|疗程|療程|我们|我們|目前|现在|現在|也|有|组合|組合|搭配|限时|限時|优惠价|優惠價|优惠|優惠|价格|價格|价钱|價錢|体验价|體驗價|只需|仅需|僅需|是|为|為|的|哦|呀|呢|啦|喔|加上|另|送)/gu;
  const remainder=text.replace(words," ").replace(zh," ").replace(/[\s,.!！。:：;；，、()（）-]+/gu,"");
  return remainder==="";
}
function comboDraftMatches(draft,decision){
  if(decision?.afterVoucher)return false;
  if(Array.isArray(decision?.individualPrices)&&decision.individualPrices.length){
    // A two-individual-plus-combo quote is inherently a different scope.
    // Keep its existing exact validated fallback until all three price
    // associations can be checked independently.
    return verifiedEquivalentReply(draft,decision.reply);
  }
  if(decision?.mode==="contextual")return verifiedEquivalentReply(draft,decision.reply);
  const text=comparableLines(draft).filter(line=>!harmlessLine(line)).join(" ");
  return comboPriceClauseMatches(text,decision)||verifiedEquivalentReply(draft,decision.reply);
}
function packageComparisonMatches(draft,decision){
  const packages=decision?.verifiedPackages;
  if(!Array.isArray(packages)||packages.length!==2)return false;
  const lines=comparableLines(draft).filter(line=>!harmlessLine(line));
  const headings=packages.map(p=>lines.findIndex(line=>comparable(line).includes(comparable(p.name))));
  if(headings.some(i=>i<0)||new Set(headings).size!==2)return false;
  const sections=packages.map((pkg,i)=>({pkg,start:headings[i]})).sort((a,b)=>a.start-b.start);
  const header=lines.slice(0,sections[0].start);
  if(header.length>1||header.some(line=>equivalentFactText(line)!==equivalentFactText(decision.heading)&&
    !/^(?:here (?:is|are) (?:the )?(?:difference|differences|comparison)|(?:the )?two packages differ as follows|ini perbezaan (?:kedua-dua|antara kedua-dua) pakej|两个配套(?:的)?(?:区别|分别)(?:是)?|兩個配套(?:的)?(?:區別|分別)(?:是)?)[\s:：.!。]*$/iu.test(comparable(line))))return false;
  return sections.every(({pkg,start},i)=>{
    const end=sections[i+1]?.start??lines.length;
    const section=lines.slice(start,end);
    if(i===sections.length-1&&equivalentFactText(section.at(-1))===equivalentFactText(decision.conclusion))section.pop();
    const heading=section.shift();
    const facts=pkg.money||{offer:pkg.price,normal:null,voucher:null,afterVoucher:false};
    // Parse the package header and any separate normal/voucher lines as
    // independently scoped money claims. Only the approved duration/title
    // and included items may accompany the prices.
    const priceLines=[heading,...section.filter(line=>scanMyrAmounts(line).length)];
    if(!verifyPackageMoney(priceLines.join("\n"),facts))return false;
    const headerText=canonicalMoney(heading);
    if(headerText===null)return false;
    const expected=canonicalMoney(pkg.name+" (RM"+pkg.price+" | "+pkg.title+"):");
    const stripped=stripDecoration(headerText);
    if(stripped!==stripDecoration(expected)){
      const base=comparable(heading).replace(comparable(pkg.name)," ").replace(comparable(pkg.title)," ");
      if(!comparable(heading).includes(comparable(pkg.name))||!comparable(heading).includes(comparable(pkg.title)))return false;
      let rest=base;
      for(const claim of scanMyrAmounts(base).reverse())rest=rest.slice(0,claim.index)+" "+rest.slice(claim.index+claim.raw.length);
      rest=rest.replace(/\b(?:current|offer|price|promo|normal|original|regular|voucher|coupon|discount|worth|after|applying|the|harga|asal|biasa|promosi|baucar|selepas|hanya|is|at|for)\b|原价|原價|优惠价|優惠價|现价|現價|优惠券|優惠券|优惠后|優惠後|仅需|僅需|只需|价格|價格/giu," ");
      if(rest.replace(/[\s()[\]{}|:：,，;；.!。+-]+/gu,""))return false;
    }
    for(const line of priceLines.slice(1)){
      const claims=monetaryClaims(line);
      if(claims.some(c=>c.role==="offer"))return false;
      let residual=comparable(line);
      for(const claim of scanMyrAmounts(residual).reverse())residual=residual.slice(0,claim.index)+" "+residual.slice(claim.index+claim.raw.length);
      if(residual.replace(/\b(?:normal|original|regular|price|voucher|coupon|discount|worth|harga|asal|biasa|baucar|of)\b|原价|原價|正常价|正常價|优惠券|優惠券|折扣券|折扣|面额|面額|价值|價值/giu,"").replace(/[\s()[\]{}|:：,，;；.!。+-]+/gu,""))return false;
    }
    const remaining=section.filter(line=>!scanMyrAmounts(line).length).map(equivalentFactText);
    const items=pkg.includedItems.map(equivalentFactText);
    return remaining.length===items.length&&remaining.every(line=>line!==null)&&
      JSON.stringify(remaining.slice().sort())===JSON.stringify(items.slice().sort());
  });
}
function subsequentDraftMatches(draft,decision){
  if(!decision?.treatment||decision.mode!=="staff_handoff"||scanMyrAmounts(draft).length)return false;
  // Only a complete, unpriced staff-confirmation statement is safe here.
  // The exact tracked suggestion is handled separately.
  const text=removeCourtesy(comparable(draft));
  const service=comparable(decision.treatment);
  const name=service.replace(/[.*+?^$(){}|[\]\\]/gu,"\\$&");
  const template=new RegExp("^(?:for "+name+",? )?(?:our (?:team|staff|clinic)|the clinic|the team) (?:can|will|needs to) confirm (?:the )?(?:individual |subsequent |later |regular |next |later-session |subsequent-session )?(?:session |single-session )?(?:price|rate|pricing)(?: (?:for|of) "+name+")?(?: (?:and|along with) (?:the )?(?:available )?package options)?[ .!]*$","iu");
  if(text.includes(service)&&template.test(text))return true;
  const zh=new RegExp("^(?:关于|關於)?"+name+"\\s*(?:续做|續做|后续|後續|第二次之后|第二次之後)(?:的)?(?:单次|單次)?(?:收费|收費|价格|價格|价钱|價錢)[，,。 ]*(?:可以|需要|会|會)?(?:由|请|請)?门店同事(?:帮你|幫你|帮您|幫您)?确认(?:哦|呀|呢)?[。！! ]*$","iu");
  const ms=new RegExp("^(?:harga|caj) (?:sesi|rawatan) (?:susulan|seterusnya) "+name+" (?:perlu|boleh) disahkan oleh (?:staf|pihak) pusat[.! ]*$","iu");
  return zh.test(text)||ms.test(text);
}
function selectVerifiedSpecialReply({draft,decision,language,kind}={}){
  const fallback=decision?.reply;
  if(typeof fallback!=="string")return fallback;
  if(typeof draft!=="string"||!draft.trim()||draft.length>1800||
    hasClinicalMediaRisk(draft)||clearReplyLanguageMismatch(draft,language))return fallback;
  // Exact tracked package invitation is used as persisted acceptance evidence.
  // Never change it without migrating that evidence contract.
  if(kind==="subsequent"&&decision.mode==="suggest_package")return fallback;
  const matched=(kind==="pelvic"&&packageComparisonMatches(draft,decision))||
    (kind==="combo"&&comboDraftMatches(draft,decision))||
    (kind==="subsequent"&&subsequentDraftMatches(draft,decision))||
    verifiedEquivalentReply(draft,fallback);
  return matched?draft:fallback;
}
module.exports={selectVerifiedSpecialReply,verifiedEquivalentReply,packageComparisonMatches,comboDraftMatches,subsequentDraftMatches};
