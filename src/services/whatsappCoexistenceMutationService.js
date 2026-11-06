"use strict";
// Business App edits/deletes mutate EXISTING sender-qualified staff messages.
// Out-of-order events are durably staged and resolved after their echo appears.
// No edit/revoke ever creates a new AI reply, customer turn or Cloud API send.
const {pool}=require("../db/db");
const {CONVERSATION_LOCK_NAMESPACE}=require("../db/conversationLock");
const {HOLD_SQL,INVALIDATE_SQL}=require("../db/staffAppointmentReminderRepo");
const {isProactiveAppointmentReminder}=require("../utils/staffAppointmentReminderText");
const senderRepo=require("../db/whatsappSenderConversationRepo");
const {createIdleAwareRecoveryWorker}=require("../utils/idleAwareRecoveryWorker");

const LOOKUP_SQL=`
 SELECT j.id,j.sender_id,j.contact_id,j.action,j.replacement_text,
        m.id AS target_id
 FROM whatsapp_sender_coexistence_mutations j
 JOIN contacts c ON c.id=j.contact_id AND c.whatsapp_sender_id=j.sender_id
 JOIN whatsapp_sender_accounts sa ON sa.id=j.sender_id AND sa.state='active'
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
 JOIN messages m ON m.contact_id=c.id AND m.whatsapp_message_id=j.target_wamid
   AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 WHERE j.status='pending' AND j.sender_id=$1 AND j.id=$2
 FOR UPDATE OF j
`;
async function applyPending({id,senderId},{
 database=pool,
}={}){
 const client=await database.connect();
 try{
  await client.query("BEGIN");
  const match=await client.query(LOOKUP_SQL,[senderId,id]);
  if(match.rows?.length!==1){await client.query("COMMIT");return null;}
  const target=match.rows[0];
  // Serialize staff echo persistence, edits and reminder activity updates.
  await client.query(`SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,[target.contact_id]);
  const update=target.action==="revoke"?
    `UPDATE messages SET content='🗑️ [Message deleted from WhatsApp Business App]',
        media_key=NULL,media_url=NULL,media_mime_type=NULL
      WHERE id=$1 AND contact_id=$2
        AND sent_by_username='WhatsApp Business App' RETURNING id`
   :`UPDATE messages SET content=$3
      WHERE id=$1 AND contact_id=$2
        AND sent_by_username='WhatsApp Business App' RETURNING id`;
  const updated=await client.query(update,
    target.action==="revoke"?[target.target_id,target.contact_id]
      :[target.target_id,target.contact_id,target.replacement_text]);
  if(updated.rows?.length!==1)throw Error("Business App target changed.");
  // The hold and source edit commit together. A deleted or tentative reminder
  // must not leave an unrelated lead blocked. Valid edited reminders can add
  // a new verified hold without inventing a CRM booking.
  if(target.action==="revoke" || !isProactiveAppointmentReminder(target.replacement_text)){
    await client.query(INVALIDATE_SQL,[target.contact_id,target.target_id,target.id]);
  }else{
    await client.query(HOLD_SQL,[target.contact_id,target.target_id,target.replacement_text]);
  }
  await client.query(
    "UPDATE whatsapp_sender_coexistence_mutations SET status='applied',target_message_id=$2,updated_at=NOW() WHERE id=$1 AND status='pending'",
    [id,target.target_id]
  );
  await client.query("COMMIT");
  return{messageId:target.target_id,contactId:target.contact_id};
 }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}
 finally{client.release();}
}
// Meta WAMIDs use base64-like segments and may include +, / and = padding.
// Still require a bounded, provider-formatted ID before updating any message.
const VALID_WAMID=/^wamid\.[A-Za-z0-9._:+/=-]{1,512}$/;
async function record(echo,contact,{
 database=pool,env=process.env,conversations=senderRepo,
}={}){
 if(!["edit","revoke"].includes(echo?.type))return null;
 if(!VALID_WAMID.test(String(echo?.id||"")) ||
    !VALID_WAMID.test(String(echo?.originalMessageId||"")) ||
    (echo.type==="edit" && (typeof echo.text!=="string" ||
      !echo.text.trim() || echo.text.length>4096))) {
   throw Error("Unsupported WhatsApp Business App edit/revoke payload.");
 }
 const owner=await conversations.senderForContact(contact.id,database);
 const senderId=Number(contact.whatsapp_sender_id);
 if(!Number.isSafeInteger(senderId)||senderId<1||
    !owner||owner.sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
    owner.meta_phone_number_id!==env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID ||
    owner.meta_account_id!==env.WHATSAPP_SECONDARY_WABA_ID ||
    contact.whatsapp_number!==owner.customer_wa_id)
   throw Error("Business App mutation sender mismatch.");
 const row=await database.query(
   `INSERT INTO whatsapp_sender_coexistence_mutations
      (sender_id,contact_id,event_wamid,target_wamid,action,replacement_text)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(sender_id,event_wamid) DO NOTHING
    RETURNING id,status`,
   [senderId,contact.id,echo.id,echo.originalMessageId,
    echo.type,echo.type==="edit"?echo.text:null]
 );
 if(row.rows?.length!==1){
   const prior=await database.query(
     "SELECT id,contact_id,target_wamid,action,replacement_text,status "+
     "FROM whatsapp_sender_coexistence_mutations WHERE sender_id=$1 AND event_wamid=$2",
     [senderId,echo.id]
   );
   const previous=prior.rows?.[0];
   if(!previous||previous.contact_id!==contact.id ||
      previous.target_wamid!==echo.originalMessageId ||
      previous.action!==echo.type ||
      previous.replacement_text!==(echo.type==="edit"?echo.text:null))
     throw Error("Business App mutation replay conflicts.");
   if(previous.status==="pending"){
     const applied=await applyPending({id:previous.id,senderId},{database});
     if(!applied)wake();
   }
   return{isNew:false,alreadySeen:true};
 }
 const applied=await applyPending({id:row.rows[0].id,senderId},{database});
 if(!applied)wake();
 return{isNew:true,...(applied||{pending:true})};
}
async function runOnce({database=pool,env=process.env,limit=20}={}){
 if(env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true")
   return{disabled:true};
 const owner=await database.query(
   "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 "+
   "AND meta_account_id=$3 AND state='active'",
   [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID]
 );
 if(owner.rows?.length!==1)return{disabled:true};
 const senderId=owner.rows[0].id;
 await database.query(
   "UPDATE whatsapp_sender_coexistence_mutations SET status='expired',updated_at=NOW() "+
   "WHERE sender_id=$1 AND status='pending' AND created_at<NOW()-INTERVAL '7 days'",
   [senderId]
 );
 const pending=await database.query(
   "SELECT id FROM whatsapp_sender_coexistence_mutations j WHERE sender_id=$1 "+
   "AND status='pending' AND "+ACTIONABLE_TARGET_SQL+
   " ORDER BY created_at LIMIT $2",
   [senderId,Math.max(1,Math.min(30,Number(limit)||20))]
 );
 let applied=0;
 for(const job of pending.rows||[]){
   if(await applyPending({id:job.id,senderId},{database}))applied++;
 }
 return{disabled:false,applied};
}
// A deletion/edit can arrive before its original Business App echo. Such an
// unmatched event must remain durable, but checking it every minute cannot
// make progress. Resume immediately when the original echo is committed.
const ACTIONABLE_TARGET_SQL=`EXISTS (
  SELECT 1 FROM contacts c
  JOIN whatsapp_sender_conversations sc
    ON sc.contact_id=c.id AND sc.sender_id=j.sender_id AND sc.state='bound'
  JOIN messages m
    ON m.contact_id=c.id AND m.whatsapp_message_id=j.target_wamid
    AND m.role='assistant' AND m.sent_by_username='WhatsApp Business App'
  JOIN whatsapp_sender_message_context mc
    ON mc.message_id=m.id AND mc.conversation_id=sc.id
  WHERE c.id=j.contact_id AND c.whatsapp_sender_id=j.sender_id
)`;
// Only immediately retry work that can actually be applied. Missing targets
// are retained for the normal 30-minute sweep and seven-day expiry.
const PENDING_SQL=`SELECT EXISTS(
   SELECT 1 FROM whatsapp_sender_coexistence_mutations j
   JOIN whatsapp_sender_accounts sender ON sender.id=j.sender_id
   WHERE sender.sender_key=$1 AND sender.meta_phone_number_id=$2
     AND sender.meta_account_id=$3 AND sender.state='active'
     AND j.status='pending' AND ${ACTIONABLE_TARGET_SQL}
 ) AS has_work`;
async function hasPendingWork({database=pool,env=process.env}={}){
 if(env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true")return false;
 const result=await database.query(PENDING_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,
 ]);
 const pending=result.rows?.[0]?.has_work;
 if(typeof pending!=="boolean")
   throw Error("Recovery queue status unavailable; retry shortly");
 return pending;
}
let worker=null;
function wake(){return worker?.wake(0)===true;}
function start({env=process.env,run=runOnce,database=pool,...clock}={}){
 if(env.WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED!=="true"||worker)return false;
 worker=createIdleAwareRecoveryWorker({
   ...clock,
   label:"Business App mutation recovery",
   run:()=>run({env,database}),
   hasPendingWork:()=>hasPendingWork({env,database}),
 });
 worker.start(0);
 return true;
}
function stop(){if(worker){worker.stop();worker=null;}}
module.exports={LOOKUP_SQL,ACTIONABLE_TARGET_SQL,PENDING_SQL,record,applyPending,runOnce,hasPendingWork,start,wake,stop};
