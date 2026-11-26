"use strict";
const {scanMyrAmounts,normalizeMoneyText}=require("./myrAmountClaims");
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const {clearReplyLanguageMismatch}=require("./replyLanguageGuard");

// A deliberately bounded fact contract for existing independently approved
// special decisions. This module never selects a service, books, escalates
// or grants media permission. Unproven drafts retain the verified fallback.
const neutral=/^(?:hi|hello|dear|yes|sure|of course|thank you|thanks|hai|helo|baik|boleh|terima kasih|您好|你好|亲爱的|親愛的|好的|可以的|当然可以|當然可以|谢谢|謝謝)$/iu;
function comparable(value){
  return normalizeMoneyText(value).replace(/[\p{Extended_Pictographic}\u200d]/gu,"")
    .replace(/\s+/gu," ").trim().toLowerCase();
}
function harmlessLine(value){
  return neutral.test(comparable(value).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu,""));
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
function packageComparisonMatches(draft,decision){
  const packages=decision?.verifiedPackages;
  if(!Array.isArray(packages)||packages.length!==2)return false;
  const amounts=scanMyrAmounts(draft);
  if(amounts.length!==2||amounts.some(c=>c.amount===null))return false;
  const lines=comparableLines(draft).filter(line=>!harmlessLine(line));
  const headings=packages.map(p=>lines.findIndex(line=>comparable(line).includes(comparable(p.name))));
  if(headings.some(i=>i<0)||new Set(headings).size!==2)return false;
  const sections=packages.map((pkg,i)=>({pkg,start:headings[i]})).sort((a,b)=>a.start-b.start);
  const header=lines.slice(0,sections[0].start);
  // Only independently approved heading and conclusion may appear outside
  // the configured package facts. The conclusion is optional.
  if(header.length>1||header.some(line=>equivalentFactText(line)!==equivalentFactText(decision.heading)))return false;
  return sections.every(({pkg,start},i)=>{
    const end=sections[i+1]?.start??lines.length;
    const section=lines.slice(start,end);
    if(i===sections.length-1&&equivalentFactText(section.at(-1))===equivalentFactText(decision.conclusion))section.pop();
    const label=canonicalMoney(section.shift());
    const expected=canonicalMoney(pkg.name+" (RM"+pkg.price+" | "+pkg.title+"):");
    if(label===null||stripDecoration(label)!==stripDecoration(expected))return false;
    const remaining=section.map(equivalentFactText);
    const facts=pkg.includedItems.map(equivalentFactText);
    return remaining.length===facts.length&&remaining.every(line=>line!==null)&&
      JSON.stringify(remaining.slice().sort())===JSON.stringify(facts.slice().sort());
  });
}
function selectVerifiedSpecialReply({draft,decision,language,kind}={}){
  const fallback=decision?.reply;
  if(typeof fallback!=="string")return fallback;
  if(typeof draft!=="string"||!draft.trim()||draft.length>1800||
    hasClinicalMediaRisk(draft)||clearReplyLanguageMismatch(draft,language))return fallback;
  // Exact tracked package invitation is used as persisted acceptance evidence.
  // Never change it without migrating that evidence contract.
  if(kind==="subsequent"&&decision.mode==="suggest_package")return fallback;
  const matched=kind==="pelvic"&&packageComparisonMatches(draft,decision)||
    verifiedEquivalentReply(draft,fallback);
  return matched?draft:fallback;
}
module.exports={selectVerifiedSpecialReply,verifiedEquivalentReply,packageComparisonMatches};
