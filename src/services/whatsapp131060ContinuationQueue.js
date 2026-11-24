"use strict";
const {pool}=require("../db/db");
const {createAdaptiveWorkerTimer}=require("../utils/adaptiveWorkerTimer");
const {automatedRepliesEnabled}=require("./automaticReplyControl");
const {recoveryActivation,canSend131060Recovery,reserveRecoveryContinuation,cancelRecoveryContinuation,RECOVERY_SECOND_TEXT}=require("./whatsapp131060Recovery");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const contactsRepo=require("../db/contactsRepo");
const messagesRepo=require("../db/messagesRepo");
const evidenceRepo=require("../db/outboundMessageEvidenceRepo");
const cancellation=require("./aiReplyCancellationService");
const realtimeEvents=require("../utils/realtimeEvents");
const {scopeForPersistedContact}=require("../utils/verifiedWhatsAppEventScope");

const CLAIM_SQL=`
WITH ready AS (
 SELECT q.first_message_id FROM whatsapp_131060_continuations q
 JOIN contacts c ON c.id=q.contact_id
 JOIN messages first_menu ON first_menu.id=q.first_message_id AND first_menu.contact_id=c.id
 JOIN inbound_outbound_attempts a ON a.assistant_message_id=first_menu.id
   AND a.inbound_message_id=q.inbound_message_id AND a.contact_id=c.id
   AND a.origin='system_fallback' AND a.outcome='accepted'
   AND a.provider_message_id=first_menu.whatsapp_message_id
 JOIN whatsapp_sender_billing_gates g ON g.sender_id=c.whatsapp_sender_id
   AND g.owner_contact_id=c.id AND g.state='idle'
 WHERE q.state='pending' AND q.expires_at>NOW()
   AND first_menu.delivery_status IS DISTINCT FROM 'failed'
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm WHERE alarm.sender_id=g.sender_id)
 ORDER BY q.expires_at,q.first_message_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED
)
UPDATE whatsapp_131060_continuations q SET state='claimed',updated_at=NOW()
FROM ready WHERE q.first_message_id=ready.first_message_id RETURNING q.*`;

async function finish(database,id,state) {
 await database.query("UPDATE whatsapp_131060_continuations SET state=$2,updated_at=NOW() WHERE first_message_id=$1 AND state='claimed'",[id,state]);
}
async function runOnce({database=pool,env=process.env,contacts=contactsRepo,messages=messagesRepo,
 send=sendSecondaryStaffText,evidence=evidenceRepo,reserve=reserveRecoveryContinuation,
 cancel=cancelRecoveryContinuation,eligible=canSend131060Recovery}={}) {
 if(!recoveryActivation(env))return null;
 await database.query(`UPDATE whatsapp_131060_continuations SET state=CASE WHEN state='pending' THEN 'cancelled' ELSE 'unknown' END,updated_at=NOW()
  WHERE (state='pending' AND expires_at<=NOW()) OR (state='claimed' AND expires_at<NOW()-INTERVAL '2 minutes')`);
 if(!automatedRepliesEnabled(env))return null;
 for(let i=0;i<5;i++){
  const job=(await database.query(CLAIM_SQL)).rows[0];
  if(!job)break;
  const id=Number(job.first_message_id),contactId=Number(job.contact_id),inboundMessageId=Number(job.inbound_message_id);
  const args={contactId,inboundMessageId,firstRecoveryMessageId:id,database,env};
  let saved=null;
  try {
   const contact=await contacts.getContactById(contactId);
   if(!contact || !await eligible(args)){await finish(database,id,"cancelled");continue;}
   const key=cancellation.keyForContact(contact),token=cancellation.snapshot(key);
   const current=async(ignoreOutboundMessageId=null)=>{
    if(!automatedRepliesEnabled(env)||!cancellation.safeToSend(key,token)||!cancellation.inboundMessageCanSend(inboundMessageId))return false;
    const live=await database.query("SELECT 1 FROM whatsapp_131060_continuations WHERE first_message_id=$1 AND state='claimed' AND expires_at>NOW()",[id]);
    return live.rows.length===1 && await eligible({...args,ignoreOutboundMessageId});
   };
   if(!await current()){await finish(database,id,"cancelled");continue;}
   saved=await reserve({...args,buttons:job.buttons});
   if(!saved){await finish(database,id,"cancelled");continue;}
   await database.query("UPDATE whatsapp_131060_continuations SET second_message_id=$2 WHERE first_message_id=$1 AND state='claimed'",[id,saved.id]);
   const result=await send({contact,messageId:saved.id,text:RECOVERY_SECOND_TEXT,
     origin:"system_fallback",interactiveButtons:job.buttons,anchorMessageId:inboundMessageId,
     firstRecoveryMessageId:id,preSendCheck:()=>current(saved.id)},{database,env});
   // Only proof that no reservation/provider call happened permits deferred
   // retry; an existing reservation or ambiguous outcome must never replay.
   if(result?.code==="secondary_billing_previous_send_unresolved" && result.noReservation===true &&
      result.preProviderCancelled===true && !result.wamid && !result.ambiguous && !result.unknown &&
      await cancel(saved.id,contactId,database)){
    await database.query("UPDATE whatsapp_131060_continuations SET state='pending',second_message_id=NULL,updated_at=NOW() WHERE first_message_id=$1 AND state='claimed'",[id]);
    break;
   }
   if(result?.cancelled && !result.ambiguous && !result.unknown && await cancel(saved.id,contactId,database)){
    await finish(database,id,"cancelled");continue;
   }
   if(result?.noReservation===true && result.preProviderCancelled===true &&
      !result.wamid && !result.ambiguous && !result.unknown &&
      await cancel(saved.id,contactId,database)){
    await finish(database,id,"failed");continue;
   }
   const accepted=result?.success===true && Boolean(result.wamid);
   const uncertain=result?.unknown===true||result?.ambiguous===true;
   if(result?.wamid)await messages.setWhatsappMessageId(saved.id,result.wamid,{preserveVerifiedSecondaryReceipt:true});
   else if(!accepted)await messages.setDeliveryStatusById(saved.id,uncertain?"unknown":"failed",
     result?.error||"Optional recovery message not delivered.");
   await evidence.recordOutcome({messageId:saved.id,contactId,channel:"whatsapp",origin:"system_fallback",accepted,providerMessageId:accepted?result.wamid:null},database);
   realtimeEvents.publish("conversation_changed",{...scopeForPersistedContact(contact,env),contactId,messageId:saved.id,reason:"message"});
   await finish(database,id,accepted?"sent":uncertain?"unknown":result?.cancelled?"cancelled":"failed");
   // A definite optional failure is visible on its row; do not switch the
   // conversation into delivery attention. Genuine uncertainty still alerts.
   if(uncertain)await contacts.setDeliveryAttention(contactId,"Delivery unconfirmed: optional recovery message requires billing review.",saved.id);
  }catch(err){
   // A crash/exception after claim is intentionally fail-closed. The billing
   // ledger and any saved unknown message remain available for staff review.
   await finish(database,id,"unknown").catch(()=>{});
   console.warn("[131060 continuation] delivery not confirmed:",err?.message);
  }
 }
 const pending=await database.query(`SELECT MIN(CASE WHEN state='pending' THEN NOW()+INTERVAL '5 seconds'
    ELSE expires_at+INTERVAL '2 minutes' END) AS due FROM whatsapp_131060_continuations
    WHERE state IN ('pending','claimed')`);
 const due=pending.rows[0]?.due;
 return due?Math.max(1000,Math.min(240000,new Date(due).getTime()-Date.now())):null;
}
let worker;
function wake(){return worker?.wake(0)===true;}
function start({database=pool,env=process.env,run=runOnce,...clock}={}){
 if(worker||!recoveryActivation(env))return false;
 worker=createAdaptiveWorkerTimer({...clock,label:"Secondary 131060 continuation",
  run:()=>run({database,env}),delayForResult:delay=>delay});
 worker.start(0);return true;
}
function stop(){worker?.stop();worker=null;}
module.exports={CLAIM_SQL,runOnce,start,wake,stop};
