"use strict";

// Meta's consented Business App onboarding history is NOT a live customer
// message. Never pass it through processIncomingMessage, inbound claims,
// AI scheduling, 24h policy, billing or marketing consent handlers.
const crypto=require("node:crypto");
const {pool}=require("../db/db");
const senderRepo=require("../db/whatsappSenderConversationRepo");
const {normalizeWhatsappNumber}=require("../utils/whatsappPhoneNormalization");

const FIELDS=new Set(["history","smb_app_state_sync"]);
const MAX_MESSAGES=2000;
function enabled(env=process.env){
 return env.WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED==="true" &&
   env.WHATSAPP_MULTI_NUMBER_READ_ENABLED==="true" &&
   env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED==="true";
}
function fingerprint(account,change){
 return crypto.createHash("sha256").update(JSON.stringify({account,change})).digest("hex");
}
function cleanPhone(value){
 const str=String(value||"");
 if(!/^[+\d\s().-]{8,28}$/.test(str))return null;
 const normalized=normalizeWhatsappNumber(str);
 return /^\d{8,15}$/.test(normalized)?normalized:null;
}
function mediaPlaceholder(message){
 const type=String(message?.type||"");
 if(type==="text")return String(message?.text?.body||"").slice(0,4096);
 if(["image","video","audio","document","sticker"].includes(type))
   return "["+type+" from WhatsApp Business App history: media not imported]";
 return null;
}
async function importPassiveChange({accountId,change},{
 database=pool,env=process.env,conversations=senderRepo,
}={}){
 if(!enabled(env)||!FIELDS.has(change?.field)||
    String(accountId)!==String(env.WHATSAPP_SECONDARY_WABA_ID) ||
    change.value?.metadata?.phone_number_id!==env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)
   return{enabled:false,imported:0};
 const hash=fingerprint(accountId,change);
 const old=await database.query(
   "SELECT outcome,messages_count FROM whatsapp_sender_coexistence_sync_events WHERE fingerprint=$1",
   [hash]
 );
 if(old.rows?.length)return{duplicate:true,imported:0};
 const sender=await database.query(
   "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 "+
   "AND meta_account_id=$3 AND state='active' AND coexistence_enabled=TRUE",
   [env.WHATSAPP_SECONDARY_SENDER_KEY,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
 );
 if(sender.rows?.length!==1)throw Error("Coexistence sync sender not verified/active.");
 const senderId=sender.rows[0].id;
 const entries=change.field==="history"?(change.value?.history||[]):(change.value?.state_sync||[]);
 if(!Array.isArray(entries)||entries.length>MAX_MESSAGES)throw Error("Coexistence sync batch too large");
 let threads=0, imported=0, contacts=0,declined=false;
 if(change.field==="history"){
   for(const chunk of entries){
     if(chunk?.errors?.some(e=>Number(e.code)===2593109)){declined=true;continue;}
     if(!Array.isArray(chunk?.threads))continue;
     for(const thread of chunk.threads){
       const phone=cleanPhone(thread?.id);
       if(!phone||!Array.isArray(thread.messages))continue;
       threads++;
       const contact=await conversations.claimSenderContact({
         accountId,phoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
         customerPhone:phone,
       },database,env);
       if(!contact?.whatsapp_sender_conversation_id)throw Error("History conversation not bound.");
       for(const msg of thread.messages){
         if(imported>=MAX_MESSAGES)throw Error("Coexistence message count exceeds batch limit.");
         const wamid=String(msg?.id||"");
         const content=mediaPlaceholder(msg);
         const timestamp=Number(msg?.timestamp);
         const now=Date.now()/1000;
         if(!/^wamid\.[A-Za-z0-9._:-]+$/.test(wamid) || content==null ||
            !Number.isFinite(timestamp) ||
            timestamp>now+60 || timestamp<now-366*86400)continue;
         const from=cleanPhone(msg.from);
         const to=cleanPhone(msg.to);
         // Confirm message direction from the ORIGINAL sender/recipient.
         // A history item with ambiguous direction is skipped, never guessed.
         const inbound=from===phone && (!to||to!==phone);
         const outbound=to===phone && from!==phone;
         if(inbound===outbound)continue;
         const client=await database.connect();
         try{
           await client.query("BEGIN");
           const saved=await client.query(
             `INSERT INTO messages
                (contact_id,role,content,whatsapp_message_id,sent_by_username,
                 created_at,source_created_at)
              VALUES($1,$2,$3,$4,$5,TO_TIMESTAMP($6),TO_TIMESTAMP($6))
              ON CONFLICT(whatsapp_message_id) DO NOTHING
              RETURNING id`,
             [contact.id,inbound?"user":"assistant",content,wamid,
               outbound?"WhatsApp Business App":null,timestamp]
           );
           if(saved.rows?.length===1){
             const mid=saved.rows[0].id;
             const mapped=await client.query(
               `INSERT INTO whatsapp_sender_message_context(message_id,conversation_id)
                VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id`,
               [mid,contact.whatsapp_sender_conversation_id]
             );
             if(mapped.rowCount!==1)throw Error("History sender context not owned.");
             await client.query(
               `INSERT INTO whatsapp_sender_coexistence_history_messages
                (message_id,sender_id,source_wamid_hash)
                VALUES($1,$2,$3)`,
               [mid,senderId,crypto.createHash("sha256").update(wamid).digest("hex")]
             );
             imported++;
           }else{
             const owner=await client.query(
               `SELECT m.contact_id FROM messages m WHERE m.whatsapp_message_id=$1`,
               [wamid]
             );
             if(owner.rows?.[0]?.contact_id!==contact.id)
               throw Error("Cross-sender history WAMID collision.");
           }
           await client.query("COMMIT");
         }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}
         finally{client.release();}
       }
     }
   }
 }else{
   for(const entry of entries){
     if(entry?.type!=="contact" || !["add","update",undefined,null].includes(entry.action))continue;
     const phone=cleanPhone(entry?.contact?.phone_number);
     if(!phone)continue;
     const name=String(entry.contact?.full_name || entry.contact?.first_name || "")
       .trim().slice(0,160);
     const contact=await conversations.claimSenderContact({
       accountId,phoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
       customerPhone:phone,
     },database,env);
     if(name)await database.query(
       "UPDATE contacts SET whatsapp_profile_name=COALESCE(NULLIF(whatsapp_profile_name,''),$2) "+
       "WHERE id=$1 AND whatsapp_sender_id=$3",
       [contact.id,name,senderId]
     );
     contacts++;
   }
 }
 await database.query(
   `INSERT INTO whatsapp_sender_coexistence_sync_events
     (fingerprint,sender_id,event_field,outcome,threads_count,messages_count,contacts_count)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
   [hash,senderId,change.field,declined?"declined":imported||contacts?"imported":"empty",
    threads,imported,contacts]
 );
 return{enabled:true,imported,contacts,threads,declined};
}
// Webhook stage: one small signed-event INSERT per change, no contact/message
// imports before ACK. Later worker retries by WAMID and source-event digest.
async function acceptPassiveSync(body,{database=pool,env=process.env}={}){
 if(!enabled(env))return{enabled:false,staged:0};
 let staged=0;
 for(const entry of body?.entry||[]){
   for(const change of entry?.changes||[]){
     if(!FIELDS.has(change.field) ||
        String(entry.id)!==String(env.WHATSAPP_SECONDARY_WABA_ID) ||
        change.value?.metadata?.phone_number_id!==
          env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)continue;
     const sender=await database.query(
       "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 "+
       "AND meta_phone_number_id=$2 AND meta_account_id=$3 "+
       "AND state='active' AND coexistence_enabled=TRUE",
       [env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID]
     );
     if(sender.rows?.length!==1)throw Error("Coexistence importer sender not verified.");
     const raw=JSON.stringify({accountId:entry.id,change});
     if(raw.length>4*1024*1024)throw Error("Coexistence sync chunk exceeds verified staging limit.");
     const saved=await database.query(
       `INSERT INTO whatsapp_sender_coexistence_import_jobs
         (fingerprint,sender_id,event_field,payload)
        VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(fingerprint) DO NOTHING
        RETURNING fingerprint`,
       [fingerprint(entry.id,change),sender.rows[0].id,change.field,raw]
     );
     if(saved.rowCount===1)staged++;
   }
 }
 return{enabled:true,staged};
}
async function runOnce({
 database=pool,env=process.env,maxJobs=2,
}={}){
 if(!enabled(env))return{disabled:true,processed:0,failed:0};
 const sender=await database.query(
   "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 "+
   "AND meta_phone_number_id=$2 AND meta_account_id=$3 "+
   "AND state='active' AND coexistence_enabled=TRUE",
   [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID]
 );
 if(sender.rows?.length!==1)return{disabled:true,processed:0,failed:0};
 const id=sender.rows[0].id;
 // A crashed importer can safely retry; message inserts are WAMID-idempotent.
 await database.query(
   "UPDATE whatsapp_sender_coexistence_import_jobs "+
   "SET status='pending',next_attempt_at=NOW(),updated_at=NOW() "+
   "WHERE sender_id=$1 AND status='processing' "+
   "AND updated_at<NOW()-INTERVAL '10 minutes'",[id]
 );
 // Bound sensitive raw payload retention even if no worker can process it.
 await database.query(
   "UPDATE whatsapp_sender_coexistence_import_jobs "+
   "SET status='expired',payload=NULL,updated_at=NOW() "+
   "WHERE sender_id=$1 AND payload IS NOT NULL "+
   "AND created_at<NOW()-INTERVAL '7 days' "+
   "AND status IN('pending','processing','failed')",[id]
 );
 const list=await database.query(
   "SELECT fingerprint FROM whatsapp_sender_coexistence_import_jobs "+
   "WHERE sender_id=$1 AND status='pending' AND next_attempt_at<=NOW() "+
   "ORDER BY created_at LIMIT $2",
   [id,Math.max(1,Math.min(3,Number(maxJobs)||2))]
 );
 let processed=0,failed=0;
 for(const job of list.rows||[]){
   const claimed=await database.query(
     `UPDATE whatsapp_sender_coexistence_import_jobs
      SET status='processing',attempts=attempts+1,updated_at=NOW()
      WHERE fingerprint=$1 AND sender_id=$2 AND status='pending'
      RETURNING payload,attempts`,
     [job.fingerprint,id]
   );
   if(claimed.rowCount!==1)continue;
   try{
     const payload=claimed.rows[0].payload;
     if(!payload||String(payload.accountId)!==
       String(env.WHATSAPP_SECONDARY_WABA_ID))
       throw Error("Archived sync sender identity mismatch.");
     await importPassiveChange(payload,{database,env});
     await database.query(
       `UPDATE whatsapp_sender_coexistence_import_jobs
        SET status='completed',payload=NULL,last_error=NULL,updated_at=NOW()
        WHERE fingerprint=$1 AND sender_id=$2 AND status='processing'`,
       [job.fingerprint,id]
     );
     processed++;
   }catch(err){
     const error=String(err?.message||"unknown_sync_failure").slice(0,140);
     const saved=await database.query(
       `UPDATE whatsapp_sender_coexistence_import_jobs
        SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
            last_error=$3,next_attempt_at=NOW()+INTERVAL '2 minutes',
            updated_at=NOW()
        WHERE fingerprint=$1 AND sender_id=$2 AND status='processing'
        RETURNING status`,
       [job.fingerprint,id,error]
     );
     if(saved.rows?.[0]?.status==='failed')failed++;
     console.error("[WhatsApp Coexistence] history import requires review:",error);
   }
 }
 return{disabled:false,processed,failed};
}
let timer=null;
function start({env=process.env,setIntervalFn=setInterval,run=runOnce}={}){
 if(!enabled(env)||timer)return false;
 timer=setIntervalFn(()=>run({env}).catch(e=>
   console.error("[WhatsApp Coexistence] import worker:",e?.message)),60000);
 timer?.unref?.();return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={enabled,cleanPhone,mediaPlaceholder,importPassiveChange,
 acceptPassiveSync,runOnce,start,stop};
