"use strict";
const {pool}=require("./db");
const {classifyVerifiedTreatmentTurn}=require("../services/whatsappSecondaryFollowUpDecision");

// Only a newly recorded, sender-bound, provider-timestamped CUSTOMER text
// may update this state. No CRM label, AI summary or ad name may create it.
// The maximum message ID wins, preventing webhook replays overwriting a
// newer customer withdrawal, switch or unresolved comparison.
const RECORD_SQL=`
 INSERT INTO whatsapp_sender_followup_treatment_state
   (sender_id,contact_id,source_message_id,status,treatment_name)
 SELECT sa.id,c.id,m.id,$4::text,$5::text
 FROM whatsapp_sender_accounts sa
 JOIN contacts c ON c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc
   ON sc.sender_id=sa.id AND sc.contact_id=c.id
   AND sc.state='bound' AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages m ON m.id=$2 AND m.contact_id=c.id
 JOIN whatsapp_sender_message_context mc
   ON mc.message_id=m.id AND mc.conversation_id=sc.id
 WHERE c.id=$1 AND c.channel='whatsapp' AND c.mode='ai'
   AND sa.sender_key='neutro_secondary' AND sa.state='active'
   AND sa.sender_key=$3
   AND m.role='user' AND m.whatsapp_message_id IS NOT NULL
   AND m.source_created_at IS NOT NULL
   AND m.media_mime_type IS NULL AND m.is_forwarded IS DISTINCT FROM TRUE
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_coexistence_history_messages historical
     WHERE historical.sender_id=sa.id AND historical.message_id=m.id
   )
 ON CONFLICT (sender_id,contact_id) DO UPDATE
   SET source_message_id=EXCLUDED.source_message_id,
       status=EXCLUDED.status,treatment_name=EXCLUDED.treatment_name,
       updated_at=NOW()
   WHERE whatsapp_sender_followup_treatment_state.source_message_id <
         EXCLUDED.source_message_id
 RETURNING status,treatment_name,source_message_id
`;


 // Bring AUTOMATION-owned CRM treatment labels into line with a newly
 // provider-verified customer selection. This is *not* a consent write:
 // marketing still needs an independent, treatment-scoped opt-in. Never
 // overwrite a staff-owned or manually-created lead, a closed appointment,
 // or an imported/unsigned message. The newest saved decision wins.
const RECONCILE_CRM_SQL=`
 WITH chosen AS (
   SELECT state.contact_id,state.treatment_name
   FROM whatsapp_sender_followup_treatment_state state
   JOIN whatsapp_sender_accounts sa ON sa.id=state.sender_id
     AND sa.sender_key=$3 AND sa.sender_key='neutro_secondary'
     AND sa.state='active'
   JOIN contacts c ON c.id=state.contact_id AND c.whatsapp_sender_id=sa.id
     AND c.channel='whatsapp' AND c.mode='ai' AND c.takeover_by IS NULL
   JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
     AND sc.contact_id=c.id AND sc.state='bound'
     AND sc.customer_wa_id=c.whatsapp_number
   JOIN messages msg ON msg.id=state.source_message_id
     AND msg.contact_id=c.id AND msg.role='user'
     AND msg.whatsapp_message_id IS NOT NULL
     AND msg.source_created_at IS NOT NULL
   JOIN whatsapp_sender_message_context ctx ON ctx.message_id=msg.id
     AND ctx.conversation_id=sc.id
   WHERE state.contact_id=$1 AND state.source_message_id=$2
     AND state.status='selected'
     AND NULLIF(BTRIM(state.treatment_name),'') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_sender_coexistence_history_messages imported
       WHERE imported.sender_id=sa.id AND imported.message_id=msg.id
     )
 ), latest AS (
   SELECT l.id FROM leads l JOIN chosen ON chosen.contact_id=l.contact_id
   ORDER BY l.created_at DESC,l.id DESC LIMIT 1
 )
 UPDATE leads l SET treatment_interest=chosen.treatment_name,updated_at=NOW()
 FROM chosen,latest
 WHERE l.id=latest.id AND l.contact_id=chosen.contact_id
   AND l.created_by='Automation' AND l.source='meta_ads'
   AND l.owner_username IS NULL AND l.is_closed IS DISTINCT FROM TRUE
   AND COALESCE(l.appointment_status,'none')
     NOT IN('set','visited','confirmed','booked','completed')
   AND LOWER(BTRIM(COALESCE(l.treatment_interest,'')))
       IS DISTINCT FROM LOWER(BTRIM(chosen.treatment_name))
 RETURNING l.id,l.treatment_interest
`;

async function recordFromInbound({contactId,messageId,senderKey,text,clinicConfig},
 {database=pool}={}){
 if(senderKey!=="neutro_secondary" ||
    !Number.isSafeInteger(Number(contactId)) ||
    !Number.isSafeInteger(Number(messageId)))return{recorded:false};
 const decision=classifyVerifiedTreatmentTurn({text,clinicConfig});
 if(!decision)return{recorded:false};
 const result=await database.query(RECORD_SQL,
   [contactId,messageId,senderKey,decision.status,decision.treatment]);
 const recorded=result.rowCount===1;
 let crmReconciled=false;
 if(recorded && decision.status==="selected"){
   try{
     const synced=await database.query(RECONCILE_CRM_SQL,
       [contactId,messageId,senderKey]);
     crmReconciled=(synced.rowCount||0)>0;
   }catch(error){
     // The persisted sender-specific choice remains authoritative to the
     // marketing selector even if this optional CRM synchronization fails.
     console.warn("[Secondary follow-up] CRM treatment sync unavailable:",
       error?.message);
   }
 }
 return{recorded,decision:recorded?decision:null,crmReconciled};
}
module.exports={RECORD_SQL,RECONCILE_CRM_SQL,recordFromInbound};
