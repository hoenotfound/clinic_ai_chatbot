"use strict";
// In-window follow-up topic only. Does not mutate confirmed treatment,
// CRM, marketing permission, Before & After triggers or ordinary AI replies.
const {serviceCandidates,findServicesInText}=require("./conversationPromptContext");
const BODY=/(?:肚子|小腹|腹部|腹直肌|腰|臀|骨盆|盆骨|体态|體態|产后|產後|生完|剖腹|顺产|順產|瘦身|身材|postpartum|c.?section|belly|stomach|waist|pelvi|posture|body shape|lepas bersalin|perut)/iu;
const FACE=/(?:面部|脸|臉|小颜|小顏|眼袋|下巴|轮廓|輪廓|抗衰|皱纹|皺紋|facial|face|jaw|chin|wrinkle|wajah|muka)/iu;
const BREAST=/(?:乳|胸|breast|payudara)/iu;
const RECOMMEND=/(?:建议|建議|推荐|推薦|选择|選擇|比较适合|比較適合|更适合|更適合|可以先|recommend|suggest|better for|start with|sesuai|cadang)/iu;
const STAFF_OFFER=/(?:建议|建議|推荐|推薦|选择|選擇|护理|護理|疗程|療程|调理|調理|配套|套餐|治疗|治療|recommend|suggest|package|pakej|treatment|therapy|rawatan)/iu;
const CANCEL=/(?:不想要|不想做|不要|没兴趣|沒興趣|算了|不用了|暂停|暫停|not interested|no longer|don't want|do not want|stop|tak nak|tak mahu)/iu;
const NEGATIVE_ADVICE=/(?:不(?:建议|建議|推荐|推薦|适合|適合|应|應|要|做|需要|考虑|考慮)|(?:不|未)适宜|不宜|避免|暂时别|暫時別|先不要|不可以|不能|无需|無需|别做|別做|not\s+(?:recommend(?:ed)?|suitable|appropriate|advised)|(?:do\s+not|don't|wouldn't)\s+(?:recommend|choose|do)|should\s+not|avoid|unsuitable|not\s+for\s+you|tidak\s+sesuai|tak\s+sesuai|jangan\s+(?:buat|pilih|ambil)|bukan\s+rawatan)/iu;
const PACKAGE_REFERENCE=/(?:\bpackage\s*[a-z0-9]+\b|\bpakej\s*[a-z0-9]+\b|[A-C][套配]餐)/iu;
function orderedTurns(turns) {
 return (Array.isArray(turns)?turns:[]).filter(t=>t&&Number.isSafeInteger(Number(t.id))&&
  ["user","assistant"].includes(t.role)&&typeof t.content==="string"&&t.content.trim())
  .sort((a,b)=>Number(a.id)-Number(b.id)).slice(-32);
}
function mentioned(text,candidates){return [...new Set(findServicesInText(String(text||""),candidates))];}
function configuredPackageMention(text,config){
 const matches=[];
 for(const promo of config?.promotions||[]){
  for(const pkg of promo?.packages||[]){
   const name=String(pkg?.name||"").trim();
   if(!name)continue;
   const escaped=name.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&");
   if(new RegExp("(?:^|[^A-Za-z0-9])"+escaped+"(?=$|[^A-Za-z0-9])","iu").test(text))
    matches.push(promo.linkedService);
  }
 }
 return [...new Set(matches.filter(Boolean))];
}
function negatedStaffOffer(text,config,candidates){
 return String(text||"").split(/[，,。.!！?？;；\n]|\b(?:but|instead|tapi|tetapi)\b/iu)
  .some(clause=>NEGATIVE_ADVICE.test(clause) &&
    (mentioned(clause,candidates).length>0 ||
     configuredPackageMention(clause,config).length>0 ||
     PACKAGE_REFERENCE.test(clause)));
}
function staffService(text,config,candidates){
 if(negatedStaffOffer(text,config,candidates))return null;
 if(RECOMMEND.test(text)){
  const packages=configuredPackageMention(text,config);
  if(packages.length===1)return packages[0];
  if(packages.length>1)return null;
 }
 // A postpartum recovery comment is not a recommendation for 产后调理.
 if(!STAFF_OFFER.test(text))return null;
 const introduction=String(text).split(/(?:包含|包括|内含|內含|includes?|✅|✨)/iu)[0];
 const leading=mentioned(introduction,candidates);
 if(leading.length===1)return leading[0];
 if(leading.length>1)return null;
 const full=mentioned(text,candidates);
 return full.length===1?full[0]:null;
}
function customerContext(text,service,candidates){
 const value=String(text||"");
 if(!value||CANCEL.test(value))return false;
 const named=mentioned(value,candidates);
 if(named.length===1&&named[0]===service)return true;
 if(named.some(other=>other!==service))return false;
 // An unspecified "which package?" cannot support any unrelated treatment.
 if(/(?:骨盆|脉冲|脈衝)/u.test(service))return BODY.test(value);
 if(/(?:3D|9D|小颜|小顏|逆龄|逆齡)/iu.test(service))return FACE.test(value);
 if(/(?:乳腺|胸部)/u.test(service))return BREAST.test(value);
 if(/(?:子宫|子宮|产后|產後|体态|體態)/u.test(service))return BODY.test(value);
 return false;
}
function resolveStaffDiscussedFollowUpTopic({turns,clinicConfig,lastConfirmedMessageId=0}={}){
 const ordered=orderedTurns(turns);
 const candidates=serviceCandidates(clinicConfig?.services,clinicConfig?.serviceAliases);
 const confirmedId=Number(lastConfirmedMessageId)||0;
 for(let index=ordered.length-1;index>=0;index--){
  const staff=ordered[index];
  if(staff.role!=="assistant"||Number(staff.id)<=confirmedId)continue;
  // The newer rejection supersedes any earlier positive staff recommendation.
  if(negatedStaffOffer(staff.content,clinicConfig,candidates))return null;
  const treatment=staffService(staff.content,clinicConfig,candidates);
  if(!treatment){
   const named=mentioned(staff.content,candidates);
   if(STAFF_OFFER.test(staff.content)&&named.length>1&&
      !/(?:包含|包括|内含|內含|includes?|✅|✨)/iu.test(staff.content))return null;
   continue;
  }
  const later=ordered.slice(index+1).filter(t=>t.role==="user");
  if(later.some(t=>CANCEL.test(t.content)||
    mentioned(t.content,candidates).some(name=>name!==treatment)))return null;
  const earlier=ordered.slice(0,index).filter(t=>t.role==="user").slice(-12);
  // Latest named customer choice takes precedence. Changing a different
  // previously selected service needs newer customer-initiated context.
  const latestNamed=[...earlier].reverse().find(t=>mentioned(t.content,candidates).length>0);
  const latestNames=latestNamed?mentioned(latestNamed.content,candidates):[];
  if(latestNames.length>1)return null;
  const support=latestNames.length===1&&latestNames[0]!==treatment
   ? earlier.filter(t=>Number(t.id)>Number(latestNamed.id)) : earlier;
  const supported=support.some(t=>{
   const customerAt=Date.parse(t.created_at||t.createdAt||"");
   const staffAt=Date.parse(staff.created_at||staff.createdAt||"");
   if(Number.isFinite(customerAt)&&Number.isFinite(staffAt)&&
     (staffAt<customerAt||staffAt-customerAt>4*60*60*1000))return false;
   return customerContext(t.content,treatment,candidates);
  });
  if(supported)return {treatment,staffMessageId:Number(staff.id),kind:"staff_discussed"};
 }
 return null;
}
function staffTopicFeatureEnabled(env=process.env){
 return env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED==="true";
}
module.exports={resolveStaffDiscussedFollowUpTopic,staffTopicFeatureEnabled};
