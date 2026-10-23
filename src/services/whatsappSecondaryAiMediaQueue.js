"use strict";

// One-shot sender-owned picture queue. Never use Neutro's strict-RM0 media
// worker, media ID, provider token, retry API or billing reservations.
const {pool}=require("../db/db");
const contactsRepo=require("../db/contactsRepo");
const conversationStore=require("../utils/conversationStore");
const messagesRepo=require("../db/messagesRepo");
const secondaryPolicy=require("./whatsappSecondaryPolicyService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const {secondaryUsesPrimaryClinicContent}=require("./whatsappSenderActivationGate");

const MAX_ITEMS=5;
const RETRY_MS=90*1000;
const INTERVAL_MS=60*1000;
let timer=null;
function enabled(env=process.env){
  return secondaryUsesPrimaryClinicContent(env) &&
    env.WHATSAPP_SECONDARY_AI_SEND_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==="true" &&
    env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true";
}
function validItem(item){
  if(!item || typeof item.imageUrl!=="string" || typeof item.caption!=="string" ||
     item.imageUrl.length>2048 || item.caption.length>1024) return false;
  try{
    const url=new URL(item.imageUrl);
    return url.protocol==="https:" && Boolean(url.hostname) &&
      !url.username && !url.password;
  }catch{return false;}
}
async function enqueue({
  contactId,inboundMessageId,items,kind="promotion",sequenceOffset=0,
},{database=pool,env=process.env}={}){
  if(!enabled(env)) return false;
  if(!Number.isSafeInteger(contactId)||contactId<=0||
     !Number.isSafeInteger(inboundMessageId)||inboundMessageId<=0||
     !["promotion","result"].includes(kind)||
     !Number.isSafeInteger(sequenceOffset)||sequenceOffset<0||
     !Array.isArray(items)||!items.length||items.length+sequenceOffset>MAX_ITEMS||
     !items.every(validItem))return false;
  const client=await database.connect();
  try{
    await client.query("BEGIN");
    const owner=await client.query(
      `SELECT c.whatsapp_sender_id AS sender_id,inbound.created_at
         FROM contacts c
         JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
         JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
           AND sc.contact_id=c.id AND sc.state='bound'
         JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
           AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
         JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
           AND mc.conversation_id=sc.id
        WHERE c.id=$1 AND c.channel='whatsapp' AND c.mode='ai'
          AND c.needs_attention=FALSE
          AND c.whatsapp_opt_out_at IS NULL
          AND sa.state='active' AND sa.sender_key=$3
          AND sa.meta_phone_number_id=$4 AND sa.meta_account_id=$5`,
      [contactId,inboundMessageId,env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
    );
    if(owner.rowCount!==1){await client.query("ROLLBACK");return false;}
    for(let i=0;i<items.length;i++){
      await client.query(
        `INSERT INTO whatsapp_sender_ai_media_jobs
          (sender_id,contact_id,inbound_message_id,sequence_no,
           media_kind,image_url,caption,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,
           LEAST($8::timestamptz + INTERVAL '23 hours',NOW() + INTERVAL '3 hours'))
         ON CONFLICT(sender_id,inbound_message_id,sequence_no) DO NOTHING`,
        [owner.rows[0].sender_id,contactId,inboundMessageId,i+sequenceOffset,
          kind,items[i].imageUrl,items[i].caption,owner.rows[0].created_at]
      );
    }
    await client.query("COMMIT");
    return true;
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}

const READY_SQL=`
 SELECT job.*,c.whatsapp_number,c.whatsapp_sender_id,
        sa.sender_key AS whatsapp_sender_key,
        sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
        sa.meta_account_id AS whatsapp_sender_account_id
 FROM whatsapp_sender_ai_media_jobs job
 JOIN contacts c ON c.id=job.contact_id AND c.whatsapp_sender_id=job.sender_id
 JOIN whatsapp_sender_accounts sa ON sa.id=job.sender_id AND sa.state='active'
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages inbound ON inbound.id=job.inbound_message_id
   AND inbound.contact_id=c.id AND inbound.role='user'
   AND inbound.whatsapp_message_id IS NOT NULL
 JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
   AND mc.conversation_id=sc.id
 WHERE job.state='pending' AND job.next_attempt_at<=NOW()
   AND job.expires_at>NOW() AND c.mode='ai' AND c.needs_attention=FALSE
   AND c.whatsapp_opt_out_at IS NULL
   AND sa.sender_key=$1 AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
   AND NOT EXISTS(
     SELECT 1 FROM messages newer WHERE newer.contact_id=c.id
       AND newer.role='user'
       AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
   )
   AND NOT EXISTS(
     SELECT 1 FROM messages staff WHERE staff.contact_id=c.id
       AND staff.role='assistant' AND staff.sent_by_username IS NOT NULL
       AND staff.created_at>=inbound.created_at
   )
   AND NOT EXISTS(
     SELECT 1 FROM whatsapp_sender_ai_media_jobs previous
     WHERE previous.sender_id=job.sender_id
       AND previous.inbound_message_id=job.inbound_message_id
       AND previous.sequence_no<job.sequence_no
       AND previous.state<>'accepted'
   )
 ORDER BY job.created_at,job.contact_id,job.sequence_no
 LIMIT $4
`;
const STILL_VALID_SQL=`
 SELECT EXISTS(
   SELECT 1 FROM whatsapp_sender_ai_media_jobs job
   JOIN contacts c ON c.id=job.contact_id AND c.whatsapp_sender_id=job.sender_id
   JOIN whatsapp_sender_accounts sa ON sa.id=job.sender_id AND sa.state='active'
   JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
     AND sc.contact_id=c.id AND sc.customer_wa_id=c.whatsapp_number
     AND sc.state='bound'
   JOIN messages inbound ON inbound.id=job.inbound_message_id
     AND inbound.contact_id=c.id AND inbound.role='user'
   WHERE job.id=$1 AND job.state='claimed'
     AND job.expires_at>NOW() AND c.mode='ai' AND c.needs_attention=FALSE
     AND c.whatsapp_opt_out_at IS NULL
     AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3 AND sa.meta_account_id=$4
     AND NOT EXISTS(
       SELECT 1 FROM messages newer WHERE newer.contact_id=c.id
         AND newer.role='user'
         AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
     )
     AND NOT EXISTS(
       SELECT 1 FROM messages human WHERE human.contact_id=c.id
         AND human.role='assistant' AND human.sent_by_username IS NOT NULL
         AND human.created_at>=inbound.created_at
     )
 ) AS allowed
`;

async function runOnce({
 database=pool,env=process.env,
 contacts=contactsRepo,store=conversationStore,
 send=sendSecondaryStaffText,policy=secondaryPolicy,
 limit=5,
}={}){
 if(!enabled(env))return{disabled:true,accepted:0,pending:0};
 await database.query(
   "UPDATE whatsapp_sender_ai_media_jobs SET state='expired',updated_at=NOW() WHERE state='pending' AND expires_at<=NOW()"
 );
 const list=await database.query(READY_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   Math.max(1,Math.min(10,Number(limit)||5)),
 ]);
 let accepted=0,pending=0;
 for(const job of list.rows||[]){
   // Atomic one-shot claim; a crash after claim is UNKNOWN, never replayed.
   const claimed=await database.query(
     "UPDATE whatsapp_sender_ai_media_jobs SET state='claimed',updated_at=NOW() WHERE id=$1 AND state='pending' RETURNING id",
     [job.id]
   );
   if(claimed.rowCount!==1)continue;
   const update=async(state)=>database.query(
     "UPDATE whatsapp_sender_ai_media_jobs SET state=$2,updated_at=NOW() WHERE id=$1 AND state='claimed'",
     [job.id,state]
   );
   try{
     const contact=await contacts.getContactById(job.contact_id);
     if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
        String(contact.whatsapp_sender_id)!==String(job.sender_id) ||
        contact.whatsapp_number!==job.whatsapp_number){
       await update("unknown");continue;
     }
     const preSendCheck=async()=>{
       const check=await database.query(STILL_VALID_SQL,[
         job.id,env.WHATSAPP_SECONDARY_SENDER_KEY,
         env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
       ]);
       if(check.rows?.[0]?.allowed!==true)return false;
       const current=await contacts.getContactById(job.contact_id);
       if(current?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
          current.mode!=="ai" || current.needs_attention===true)return false;
       const preview=await policy.previewSecondaryFreeformPolicy(current,{
         database,env,now:new Date(),purpose:"service",
       });
       return preview?.policyAllowed===true;
     };
     if(!await preSendCheck()){await update("expired");continue;}
     let messageId=job.outbound_message_id;
     if(!messageId){
       const saved=await store.appendMessageForContact(
         contact.id,"assistant",job.caption,null,null,job.image_url,null,
         {publish:false}
       );
       messageId=saved.id;
       await database.query(
         "UPDATE whatsapp_sender_ai_media_jobs SET outbound_message_id=$2 WHERE id=$1 AND state='claimed'",
         [job.id,messageId]
       );
     }
     const result=await send({
       contact,messageId,text:job.caption||"[automatic image]",
       origin:"ai_media",preSendCheck,
       dispatchTransport:(transport)=>transport.sendImageByUrl(job.image_url,job.caption),
     },{env,database});
     if(result?.success===true && result?.unknown!==true &&
        /^wamid\./.test(String(result.wamid||""))){
       await messagesRepo.setWhatsappMessageId(messageId,result.wamid,{
         preserveVerifiedSecondaryReceipt:true,
       });
       await database.query(
         "UPDATE whatsapp_sender_ai_media_jobs SET state='accepted',accepted_wamid=$2,updated_at=NOW() WHERE id=$1 AND state='claimed'",
         [job.id,result.wamid]
       );
       accepted++;
     }else if(["secondary_staff_billing_blocked","secondary_billing_previous_send_unresolved",
       "secondary_billing_sender_alarm"].includes(result?.code) && !result?.unknown){
       // No provider call or billable reservation occurred. Safe to defer.
       await database.query(
         "UPDATE whatsapp_sender_ai_media_jobs SET state='pending',next_attempt_at=NOW()+($2::int * INTERVAL '1 millisecond'),updated_at=NOW() WHERE id=$1 AND state='claimed'",
         [job.id,RETRY_MS]
       );
       pending++;
     }else await update("unknown");
   }catch(err){
     await update("unknown").catch(()=>{});
     console.error("[Ariel AI media] Uncertain outcome requires manual review:",err?.message);
   }
 }
 return{disabled:false,accepted,pending};
}
function start({env=process.env,setIntervalFn=setInterval,run=runOnce}={}){
 if(!enabled(env)||timer)return false;
 timer=setIntervalFn(()=>run({env}).catch(err=>
   console.error("[Ariel AI media] Worker error:",err?.message)),INTERVAL_MS);
 timer?.unref?.();
 return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={enabled,enqueue,READY_SQL,STILL_VALID_SQL,runOnce,start,stop};
