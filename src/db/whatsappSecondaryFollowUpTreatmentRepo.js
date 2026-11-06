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

async function recordFromInbound({contactId,messageId,senderKey,text,clinicConfig},
 {database=pool}={}){
 if(senderKey!=="neutro_secondary" ||
    !Number.isSafeInteger(Number(contactId)) ||
    !Number.isSafeInteger(Number(messageId)))return{recorded:false};
 const decision=classifyVerifiedTreatmentTurn({text,clinicConfig});
 if(!decision)return{recorded:false};
 const result=await database.query(RECORD_SQL,
   [contactId,messageId,senderKey,decision.status,decision.treatment]);
 return{recorded:result.rowCount===1,decision:result.rowCount===1?decision:null};
}
module.exports={RECORD_SQL,recordFromInbound};
