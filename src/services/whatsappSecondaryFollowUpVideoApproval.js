"use strict";
// Clinic creative can be reused between its two verified WhatsApp senders.
// This approves a SOURCE R2 object only; never a primary Meta provider media
// ID, contact attachment, free-send assumption, or marketing permission.
const mediaStorage=require("./mediaStorageService");

function denied(code){return{approved:false,code};}
async function verifyApprovedVideo({
 slot,mediaKey,mediaType,confirmClinicVideoReuse,
 env=process.env,clinicConfig,storage=mediaStorage,
}={}){
 if(slot!==2 && slot!==6)return denied("secondary_video_slot_unsupported");
 if(env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED!=="true" ||
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED!=="true" ||
    env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED!=="true" ||
    env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE!=="primary" ||
    confirmClinicVideoReuse!==true || mediaType!=="video" ||
    typeof mediaKey!=="string" || !mediaKey.trim() ||
    mediaKey.length>512)return denied("secondary_followup_media_not_authorized");
 const key=mediaKey.trim();
 if(!storage.isReferencedClinicFollowUpMediaKey(key,clinicConfig,env))
  return denied("secondary_followup_media_unowned");
 let info;
 try{info=await storage.getSharedFollowUpMediaInfo(key);}
 catch{return denied("secondary_followup_video_unavailable");}
 if(info.mimeType!=="video/mp4" || !Number.isSafeInteger(info.bytes) ||
    info.bytes<=0 || info.bytes>16*1024*1024)
   return denied("secondary_followup_video_invalid");
 return {approved:true,key,mimeType:"video/mp4",filename:"clinic-followup.mp4"};
}
function isCurrentApprovedFollowUpVideo({
  slot,mediaKey,env=process.env,clinicConfig,storage=mediaStorage,
}={}){
  return (slot===2 || slot===6) &&
    env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED==="true" &&
    env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE==="primary" &&
    typeof mediaKey==="string" && mediaKey.length>0 &&
    storage.isReferencedClinicFollowUpMediaKey(mediaKey,clinicConfig,env)===true;
}
function listApprovedClinicVideos({
 env=process.env,clinicConfig,storage=mediaStorage,
}={}){
 if(env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED!=="true" ||
    env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE!=="primary" ||
    !clinicConfig?.automatedFollowUp)return[];
 const first=clinicConfig.automatedFollowUp;
 const steps=[first,...(Array.isArray(first.additionalSteps)?first.additionalSteps:[])];
 const candidates=steps.flatMap((step,i)=>{
  const entries=[{videoKey:step?.videoKey,videoFilename:step?.videoFilename,
    label:"Clinic follow-up video "+(i+1)},
   ...(Array.isArray(step?.serviceOverrides)?step.serviceOverrides.map(override=>({
    videoKey:override.videoKey,videoFilename:override.videoFilename,
    label:"Treatment: "+String(override.serviceName||"clinic video").slice(0,100),
   })):[])];
  return entries;
 });
 const seen=new Set();
 return candidates.filter(item=>{
  const key=String(item.videoKey||"").trim();
  if(!key||seen.has(key)||
     !storage.isReferencedClinicFollowUpMediaKey(key,clinicConfig,env))
    return false;
  seen.add(key);return true;
 }).map(item=>({key:item.videoKey,label:item.label}));
}
module.exports={verifyApprovedVideo,listApprovedClinicVideos,isCurrentApprovedFollowUpVideo};
