"use strict";

// Coexistence Business App echoes are ALREADY provider-accepted. Download
// their media using the verified recipient number's own token. Never invoke
// an outbound Graph send, Neutro's token fallback, or a customer AI turn.
const {pool}=require("../db/db");
const contactsRepo=require("../db/contactsRepo");
const mediaStorage=require("./mediaStorageService");
const channelMessaging=require("./channelMessagingService");

const TYPES=new Set(["image","video","audio","document","sticker"]);
const LIMIT=10;
const MAX_BYTES=25*1024*1024;
let timer=null;
function enabled(env=process.env) {
 return env.WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED==="true" &&
   env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED==="true";
}
async function enqueue({
  contactId,messageId,wamid,mediaId,type,
},{database=pool,env=process.env}={}){
 if(!enabled(env)||!TYPES.has(type)||
   !Number.isSafeInteger(Number(contactId))||
   !Number.isSafeInteger(Number(messageId))||
   !/^wamid\.[A-Za-z0-9._:-]+$/.test(String(wamid||""))||
   !/^[A-Za-z0-9._:-]{1,300}$/.test(String(mediaId||"")))return false;
 const result=await database.query(
   `INSERT INTO whatsapp_sender_coexistence_media_jobs
      (message_id,sender_id,contact_id,provider_media_id,media_type)
    SELECT m.id,c.whatsapp_sender_id,c.id,$4,$5
    FROM messages m
    JOIN contacts c ON c.id=m.contact_id
    JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
    JOIN whatsapp_sender_conversations sc
      ON sc.sender_id=sa.id AND sc.contact_id=c.id AND sc.state='bound'
    JOIN whatsapp_sender_message_context mc
      ON mc.message_id=m.id AND mc.conversation_id=sc.id
    WHERE m.id=$1 AND c.id=$2 AND m.whatsapp_message_id=$3
      AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
      AND sa.sender_key=$6 AND sa.meta_phone_number_id=$7
      AND sa.meta_account_id=$8 AND sa.state='active'
    ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
   [messageId,contactId,wamid,mediaId,type,
    env.WHATSAPP_SECONDARY_SENDER_KEY,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID]
 );
 if(result.rowCount===1)return true;
 const existing=await database.query(
   "SELECT provider_media_id,media_type FROM whatsapp_sender_coexistence_media_jobs WHERE message_id=$1",
   [messageId]
 );
 return existing.rows?.length===1 &&
   existing.rows[0].provider_media_id===mediaId &&
   existing.rows[0].media_type===type;
}
const READY_SQL=`
 SELECT j.message_id,j.contact_id,j.sender_id,j.provider_media_id,j.media_type,
        m.whatsapp_message_id,c.whatsapp_number
 FROM whatsapp_sender_coexistence_media_jobs j
 JOIN messages m ON m.id=j.message_id AND m.contact_id=j.contact_id
 JOIN contacts c ON c.id=j.contact_id AND c.whatsapp_sender_id=j.sender_id
 JOIN whatsapp_sender_accounts sa ON sa.id=j.sender_id AND sa.state='active'
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.customer_wa_id=c.whatsapp_number
   AND sc.state='bound'
 JOIN whatsapp_sender_message_context mc
   ON mc.message_id=m.id AND mc.conversation_id=sc.id
 WHERE j.status='pending' AND j.next_attempt_at<=NOW()
   AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
   AND sa.sender_key=$1 AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
 ORDER BY j.next_attempt_at,j.message_id LIMIT $4
`;
async function runOnce({
 database=pool,env=process.env,
 contacts=contactsRepo,download=channelMessaging.downloadIncomingMedia,
 storage=mediaStorage,
 maxJobs=5,
}={}){
 if(!enabled(env))return{disabled:true,processed:0,review:0};
 // A crashed GET/upload does not send a message. Reclaiming it is safe,
 // unlike the OUTBOUND secondary WhatsApp AI media queue.
 await database.query(
   "UPDATE whatsapp_sender_coexistence_media_jobs SET status='pending',next_attempt_at=NOW() " +
   "WHERE status='claimed' AND updated_at<NOW()-INTERVAL '10 minutes'"
 );
 const list=await database.query(READY_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   Math.max(1,Math.min(LIMIT,Number(maxJobs)||5))
 ]);
 let processed=0,review=0;
 for(const j of list.rows||[]){
   const claimed=await database.query(
     "UPDATE whatsapp_sender_coexistence_media_jobs SET status='claimed',attempts=attempts+1,updated_at=NOW() " +
     "WHERE message_id=$1 AND status='pending' RETURNING attempts",[j.message_id]
   );
   if(claimed.rowCount!==1)continue;
   try {
     const contact=await contacts.getContactById(j.contact_id);
     if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
        String(contact.whatsapp_sender_id)!==String(j.sender_id) ||
        contact.whatsapp_number!==j.whatsapp_number)throw new Error("sender_mismatch");
     const bytes=await download({
       channel:"whatsapp",mediaType:j.media_type,mediaId:j.provider_media_id,
       businessPhoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
       businessAccountId:env.WHATSAPP_SECONDARY_WABA_ID,
     });
     if(!Buffer.isBuffer(bytes?.buffer)||!bytes.buffer.length ||
        bytes.buffer.length>MAX_BYTES)throw new Error("media_unavailable_or_oversized");
     const mime=String(bytes.mimeType||"").split(";")[0].trim().toLowerCase();
     if(!/^(image|video|audio|application)\/[a-z0-9.+-]{1,80}$/.test(mime))
       throw new Error("invalid_media_mime");
     const key=await storage.uploadMedia(bytes.buffer,mime,{contactId:j.contact_id});
     if(!key)throw new Error("private_media_storage_failed");
     const saved=await database.query(
       `UPDATE messages m SET media_key=$2,media_mime_type=$3
        FROM whatsapp_sender_coexistence_media_jobs j,
             contacts c,
             whatsapp_sender_accounts sa,
             whatsapp_sender_conversations sc,
             whatsapp_sender_message_context mc
        WHERE j.message_id=$1 AND j.status='claimed'
          AND m.id=j.message_id AND m.contact_id=j.contact_id
          AND c.id=j.contact_id AND c.whatsapp_sender_id=j.sender_id
          AND sa.id=j.sender_id AND sa.state='active'
          AND sc.sender_id=sa.id AND sc.contact_id=c.id AND sc.state='bound'
          AND mc.conversation_id=sc.id AND mc.message_id=m.id
          AND sa.sender_key=$4 AND sa.meta_phone_number_id=$5
          AND sa.meta_account_id=$6
          AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
          AND m.whatsapp_message_id=$7
        RETURNING m.id`,
       [j.message_id,key,mime,env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID,j.whatsapp_message_id]
     );
     if(saved.rowCount!==1)throw new Error("message_identity_changed");
     await database.query(
       "UPDATE whatsapp_sender_coexistence_media_jobs SET status='complete',error_code=NULL,updated_at=NOW() " +
       "WHERE message_id=$1 AND status='claimed'",[j.message_id]
     );
     processed++;
   }catch(err){
     const code=String(err?.message||"download_error").slice(0,95)
       .replace(/[^a-zA-Z0-9_ -]/g,"_");
     const r=await database.query(
       `UPDATE whatsapp_sender_coexistence_media_jobs
        SET status=CASE WHEN attempts>=3 OR $2 IN
               ('sender_mismatch','message_identity_changed','invalid_media_mime')
             THEN 'review' ELSE 'pending' END,
            error_code=$2,
            next_attempt_at=NOW()+INTERVAL '2 minutes',
            updated_at=NOW()
        WHERE message_id=$1 AND status='claimed' RETURNING status`,
       [j.message_id,code]
     );
     if(r.rows?.[0]?.status==="review")review++;
     // This is a received, provider-authenticated staff message, not an
     // AI send failure. Preserve the truthful placeholder until restored.
     console.error("[Business App echo media] media retrieval requires review:",code);
   }
 }
 return{disabled:false,processed,review};
}
function start({env=process.env,setIntervalFn=setInterval,run=runOnce}={}){
 if(!enabled(env)||timer)return false;
 timer=setIntervalFn(()=>run({env}).catch(e=>
   console.error("[Business App echo media] worker:",e?.message)),60000);
 timer?.unref?.();return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={enabled,enqueue,READY_SQL,runOnce,start,stop};
