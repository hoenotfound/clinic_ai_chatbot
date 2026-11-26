"use strict";

function campaignDatesInText(text) {
  const value=String(text||"").normalize("NFKC");
  const out=[];
  const months="january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|januari|februari|mac|mei|julai|ogos|oktober|disember";
  const monthNumber=m=>({jan:1,feb:2,mar:3,mac:3,apr:4,may:5,mei:5,jun:6,jul:7,aug:8,ogo:8,sep:9,oct:10,okt:10,nov:11,dec:12,dis:12})[m.toLowerCase().slice(0,3)];
  const push=(month,days)=>{for(const n of String(days).match(/\d+/g)||[])out.push({month:Number(month),day:Number(n)});};
  const list="\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:and|dan|&|,|to|[-–])\\s*\\d{1,2}(?:st|nd|rd|th)?)*";
  for(const m of value.matchAll(new RegExp("\\b("+months+")\\s+("+list+")\\b","giu")))push(monthNumber(m[1]),m[2]);
  for(const m of value.matchAll(new RegExp("\\b("+list+")\\s+("+months+")\\b","giu")))push(monthNumber(m[2]),m[1]);
  for(const m of value.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})(?:\s*[日号號]?\s*(?:和|及|与|與|&|、|至|[-–])\s*(\d{1,2})(?!\s*月))?/gu))push(m[1],m[2]+(m[3]?" "+m[3]:""));
  for(const m of value.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/gu))push(m[2],m[3]);
  for(const m of value.matchAll(/(?<![\d/-])(\d{1,2})[/-](\d{1,2})(?:[/-]20\d{2})?(?![\d/-])/gu))push(m[2],m[1]);
  return out;
}

module.exports={campaignDatesInText};
