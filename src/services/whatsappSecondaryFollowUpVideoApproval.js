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
module.exports={verifyApprovedVideo};
