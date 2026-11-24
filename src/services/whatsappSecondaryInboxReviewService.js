"use strict";
const {pool}=require("../db/db");
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function context(contactId,env){
 const id=Number(contactId);
 if(!Number.isSafeInteger(id)||id<=0)fail(400,"Invalid contact.");
 if(env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
    !/^\d+$/.test(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"") ||
    !/^\d+$/.test(env.WHATSAPP_SECONDARY_WABA_ID||""))fail(409,"Secondary sender is not configured.");
 return [id,env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID];
}
const ELIGIBLE_SQL=`
 SELECT g.reservation_id,g.message_id,g.sender_id,g.contact_id,
        review.reviewed_at
 FROM whatsapp_sender_billing_gates g
 JOIN whatsapp_sender_accounts sa ON sa.id=g.sender_id
 JOIN contacts c ON c.id=g.owner_contact_id AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_billing_attempts a ON a.reservation_id=g.reservation_id
   AND a.sender_id=g.sender_id AND a.contact_id=c.id AND a.message_id=g.message_id
 JOIN messages old ON old.id=a.message_id AND old.contact_id=c.id AND old.role='assistant'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=old.id
 JOIN whatsapp_sender_conversations sc ON sc.id=mc.conversation_id
   AND sc.contact_id=c.id AND sc.sender_id=sa.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 LEFT JOIN whatsapp_sender_unknown_gate_inbox_reviews review ON review.reservation_id=a.reservation_id
 WHERE c.id=$1 AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3
   AND sa.meta_account_id=$4 AND sa.state='active'
   AND g.contact_id=c.id AND g.state='unknown' AND a.state='unknown'
   AND g.updated_at<=NOW()-INTERVAL '30 minutes'
   AND g.wamid IS NULL AND a.wamid IS NULL AND old.whatsapp_message_id IS NULL
   AND old.whatsapp_accepted_at IS NULL AND old.delivery_status='unknown'
   AND c.whatsapp_opt_out_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=old.id)
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts r
     WHERE r.sender_id=sa.id AND r.reservation_id=a.reservation_id)
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm WHERE alarm.sender_id=sa.id)
   AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_unknown_gate_new_sends used
     WHERE used.old_reservation_id=a.reservation_id OR
       (used.sender_id=sa.id AND used.contact_id=c.id AND used.reopened_at>NOW()-INTERVAL '30 days'))
`;
async function inspect({contactId},{database=pool,env=process.env}={}){
 const rows=(await database.query(ELIGIBLE_SQL,context(contactId,env))).rows;
 if(rows.length!==1)return {eligible:false};
 const row=rows[0];
 return {eligible:true,reservationId:row.reservation_id,messageId:row.message_id,
   reviewed:row.reviewed_at!=null};
}
async function approve({contactId,reservationId,actor,reason,nonDeliveryChecked,billingNoChargeChecked},
 {database=pool,env=process.env}={}){
 const args=context(contactId,env);
 const why=typeof reason==="string"?reason.trim():"";
 if(!UUID.test(String(reservationId||""))||typeof actor!=="string"||!actor.trim()||
    actor.length>100||why.length<12||why.length>500||
    nonDeliveryChecked!==true||billingNoChargeChecked!==true)
   fail(400,"Confirm non-delivery and no charge, and record the evidence.");
 const client=await database.connect();
 let tx=false;
 try{
   await client.query("BEGIN");tx=true;
   // Sender lock precedes gate lock, matching receipt ingestion and reservations.
   const sender=await client.query("SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active' FOR UPDATE",args.slice(1));
   if(sender.rows.length!==1)fail(409,"Sender could not be verified.");
   await client.query("SELECT sender_id FROM whatsapp_sender_billing_gates WHERE sender_id=$1 AND owner_contact_id=$2 FOR UPDATE",[sender.rows[0].id,args[0]]);
   const current=(await client.query(ELIGIBLE_SQL,args)).rows;
   if(current.length!==1||String(current[0].reservation_id)!==String(reservationId).toLowerCase())fail(409,"The original billing hold changed or is not eligible. Check delivery again.");
   const row=current[0];
   if(row.reviewed_at!=null)fail(409,"This reservation was already reviewed.");
   await client.query(`INSERT INTO whatsapp_sender_unknown_gate_inbox_reviews
     (reservation_id,sender_id,contact_id,old_message_id,actor,reason,non_delivery_checked,billing_no_charge_checked)
     VALUES($1,$2,$3,$4,$5,$6,TRUE,TRUE)`,[row.reservation_id,row.sender_id,row.contact_id,row.message_id,actor.trim(),why]);
   await client.query("COMMIT");tx=false;
   return {reviewed:true,sendAuthorized:false,originalRetryAllowed:false};
 }finally{if(tx)await client.query("ROLLBACK").catch(()=>{});client.release();}
}
module.exports={inspect,approve,ELIGIBLE_SQL};
