"use strict";
const crypto=require("node:crypto");
const {pool}=require("../db/db");
const videoCacheRepo=require("../db/whatsappVideoMediaCacheRepo");
const mediaStorage=require("./mediaStorageService");
const {mediaSpecificDeliveryFailure}=
  require("./whatsappSecondaryVideoVerification");

// Only the HMAC-verified delivery worker calls this. Invalidation is a
// conditional compare-and-clear of an upload, never a resend or gate release.
async function invalidateFailedSecondaryVideo({
  job,messageId,verifiedSender,
},{
  database=pool,storage=mediaStorage,cache=videoCacheRepo,env=process.env,
}={}){
 if(verifiedSender?.matched!==true || job?.delivery_status!=="failed" ||
    !mediaSpecificDeliveryFailure({
      errorCode:job.error_code,
      errorTitle:job.error_title,errorMessage:job.error_message
    }) ||
    String(job.business_phone_number_id||"")!==String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"") ||
    String(job.business_account_id||"")!==String(env.WHATSAPP_SECONDARY_WABA_ID||"") ||
    !/^[0-9]+$/.test(String(messageId||"")))return{invalidated:false,reason:"not_verified_media_failure"};
 const result=await database.query(`
   SELECT m.media_key, m.media_mime_type
   FROM messages m
   JOIN contacts c ON c.id=m.contact_id
   JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
   WHERE m.id=$1 AND m.whatsapp_message_id=$2
     AND m.delivery_status='failed' AND m.media_mime_type='video/mp4'
     AND sa.sender_key='neutro_secondary'
     AND sa.meta_phone_number_id=$3 AND sa.meta_account_id=$4
     AND sa.state='active' AND m.media_key IS NOT NULL
   LIMIT 1
 `,[messageId,job.wamid,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
     env.WHATSAPP_SECONDARY_WABA_ID]);
 const mediaKey=result.rows?.[0]?.media_key;
 if(!mediaKey || storage.isSharedFollowUpConfigKey(mediaKey,env)!==true)
   return{invalidated:false,reason:"not_shared_secondary_video"};
 const info=await storage.getSharedFollowUpMediaInfo(mediaKey);
 if(!info?.etag || info.mimeType!=="video/mp4" ||
    !Number.isFinite(info.bytes) || info.bytes<=0)
   return{invalidated:false,reason:"source_unavailable"};
 const fingerprint=crypto.createHash("sha256")
   .update(JSON.stringify([mediaKey,info.etag,info.bytes,"video/mp4"]))
   .digest("hex");
 const phoneId=String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
 const metaId=await cache.get(phoneId,fingerprint);
 if(!metaId)return{invalidated:false,reason:"not_cached"};
 const cleared=await cache.invalidate(phoneId,fingerprint,metaId);
 return{invalidated:cleared===true,reason:cleared===true?"confirmed_media_failure":"cache_changed"};
}
module.exports={invalidateFailedSecondaryVideo};
