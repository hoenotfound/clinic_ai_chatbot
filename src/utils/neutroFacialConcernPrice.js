"use strict";

// An unambiguous answer to a bot's 3D-vs-9D concern menu can select a
// treatment without spelling out "3D". Neither a CRM tag nor an ad nor a
// bare AI suggestion is enough: require the bot's exact face/3D mapping,
// a fresh customer reply, and bot confirmation before the price question.
const { hasExplicitPriceRequest }=require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk }=require("./aiReviewPolicy");
const { isVerifiedStaffTurn,pricingMessageText,isRecentPricingThread }=
  require("./priceFollowUpContext");
const { serviceCandidates,findServicesInText }=require("./conversationPromptContext");
const MAX_AGE=3*60*60*1000;
const FACE=/^(?:脸型|臉型|脸型轮廓|臉型輪廓|双下巴|雙下巴|下颚线|下顎線|大小脸|大小臉)[!！。.?？\s]*$/u;
const RESET=/(?:另外|改聊|换|換|不想|不考虑|不考慮|不是|其他|其它|instead|different|another|stop|unsubscribe|combo|组合|組合|套餐|配套)/iu;
const MENU_3D=/(?:3\s*d.{0,40}(?:脸型|臉型|轮廓|輪廓|双下巴|雙下巴|下颚线|下顎線|大小脸|大小臉))/iu;
const MENU_9D=/9\s*d/iu;
function resolveNeutroFacialConcernPrice({
 customerText,session=[],services=[],serviceAliases=[],now=Date.now(),
}={}){
 const current=String(customerText||"").trim();
 const face=services.find(s=>s?.name==="3D 小颜术");
 if(!face || !hasExplicitPriceRequest(current) || current.length>110 ||
    RESET.test(current)||hasClinicalMediaRisk(current) ||
    /(?:二次|第[二2]次|后续|後續|继续|繼續|续做|續做|repeat\s+session|second\s+(?:session|time)|subsequent)/iu.test(current))return null;
 const candidates=serviceCandidates(services,serviceAliases);
 if(findServicesInText(current,candidates).length!==0)return null;
 const turns=Array.isArray(session)?session:[];
 const last=turns.at(-1);
 if(turns.length<5||last?.role!=="user"||pricingMessageText(last).trim()!==current)return null;
 // Only the latest uninterrupted 3h window is relevant. Earlier chat
 // history cannot authorize a new price or cross an authenticated staff turn.
 let begin=turns.length;
 for(let i=turns.length-1;i>=0;i--){
  const at=turns[i]?.pricingCreatedAtMs;
  if(!Number.isFinite(at)||at<now-MAX_AGE||at>now+60_000)break;
  begin=i;
 }
 const recent=turns.slice(begin);
 if(recent.length<5||!isRecentPricingThread(recent,0,now)||
    recent.some(isVerifiedStaffTurn))return null;
 const before=recent.slice(0,-1);
 const choice=before.findLastIndex(t=>t.role==="user");
 if(choice<1||!FACE.test(pricingMessageText(before[choice]).trim()))return null;
 const question=before.slice(0,choice).findLastIndex(t=>t.role==="assistant");
 if(question<0)return null;
 const menu=pricingMessageText(before[question]);
 if(!MENU_3D.test(menu)||!MENU_9D.test(menu))return null;
 // The menu must directly precede the concern answer. Extra customer
 // turns after the menu are not proof of this choice.
 if(before.slice(question+1,choice).some(t=>t.role==="user"))return null;
 const follow=before.slice(choice+1);
 if(follow.length<1||follow.length>4||
    follow.some(t=>t.role!=="assistant"))return null;
 const named=follow.flatMap(t=>findServicesInText(pricingMessageText(t),candidates));
 if(!named.includes(face.name)||named.some(name=>name!==face.name))return null;
 return face;
}
module.exports={resolveNeutroFacialConcernPrice};
