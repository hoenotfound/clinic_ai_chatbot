"use strict";
// Source-of-truth check at dispatch time. A queue entry never grants
// permanent authorization if an operator removes/changes clinic media.
const {getActivePromotions,promotionPackages}=require("../utils/activePromotion");
function imageUrls(entry){
 if(!entry || typeof entry!=="object")return[];
 const urls=[entry.imageUrl];
 for(const language of ["en","zh","ms"]){
  const media=entry.mediaTranslations?.[language];
  if(media && typeof media==="object")urls.push(media.imageUrl);
 }
 return urls.filter(s=>typeof s==="string" && s.length>0);
}
function isCurrentApprovedClinicImage({imageUrl,kind,config,now=new Date()}={}){
 if(typeof imageUrl!=="string" || !imageUrl || !config || typeof config!=="object")return false;
 if(kind==="promotion"){
  return getActivePromotions(config.promotions,now).some(p=>
   p?.enabled!==false && promotionPackages(p).some(item=>
     imageUrls(item).includes(imageUrl)));
 }
 if(kind==="result"){
  return Array.isArray(config.resultMedia) && config.resultMedia.some(group=>
    group?.enabled===true &&
    String(group.triggerMode||"off")!=="off" &&
    Array.isArray(group.items) && group.items.some(item=>
      imageUrls(item).includes(imageUrl)));
 }
 return false;
}
module.exports={imageUrls,isCurrentApprovedClinicImage};
