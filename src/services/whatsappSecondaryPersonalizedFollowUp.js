"use strict";
// Reuse the PRIMARY Neutro AI copy policy, not the primary scheduling, sending
// or billing paths. All context is scoped to the SECONDARY bound conversation.
const generator=require("./followUpAiService");
const {hasTreatmentPriceContent}=require("../utils/initialOfferReplyGuard");
const {pool}=require("../db/db");

const CONTEXT_SQL=`
 WITH bound AS (
   SELECT sc.id AS conversation_id
   FROM whatsapp_sender_conversations sc
   JOIN whatsapp_sender_accounts sa ON sa.id=sc.sender_id
   JOIN contacts c ON c.id=sc.contact_id AND c.whatsapp_sender_id=sa.id
   WHERE c.id=$1 AND sc.id=$2 AND sc.sender_id=$3
     AND sc.state='bound' AND sa.state='active' AND sa.sender_key=$4
     AND sa.meta_phone_number_id=$5 AND sa.meta_account_id=$6
     AND sc.customer_wa_id=c.whatsapp_number
 ),
 latest_lead AS (
   SELECT l.id,l.treatment_interest,l.appointment_status,
     stage.name AS stage_name,l.branch_name
   FROM leads l LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
   WHERE l.contact_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 1
 )
 SELECT m.id,m.role,m.content,m.created_at,m.sent_by_username,
   m.is_automated_follow_up,m.delivery_status,
   (SELECT row_to_json(latest_lead) FROM latest_lead) AS lead
 FROM messages m JOIN whatsapp_sender_message_context mc
   ON mc.message_id=m.id
 JOIN bound ON bound.conversation_id=mc.conversation_id
 WHERE m.contact_id=$1 AND m.role IN('user','assistant')
   AND COALESCE(BTRIM(m.content),'')<>''
   AND m.delivery_status IS DISTINCT FROM 'failed'
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
     WHERE h.message_id=m.id AND h.sender_id=$3
   )
 ORDER BY m.created_at DESC,m.id DESC LIMIT 12
`;
function clean(v){return typeof v==="string"?v.trim():"";}
function allowedMessage(text,context){
 // A literal duplicate is never useful even if a historical assistant row
 // lacks delivery metadata required by the semantic duplicate detector.
 if(context.some(row=>row.role==="assistant" &&
   clean(row.content).toLocaleLowerCase()===text.toLocaleLowerCase()))return false;
 return text.length>=12 && text.length<=1024 &&
   !hasTreatmentPriceContent(text) &&
   !generator.hasUnsafeClinicalFollowUpClaim(text) &&
   !generator.asksForNonexistentBranchChoice(text) &&
   !generator.followUpCopyViolation(text,context);
}
async function createPersonalized20h({
 candidate,database=pool,env=process.env,
 generate=generator.generatePersonalizedFollowUp,
}={}){
 if(env.WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED!=="true" ||
    !candidate || Number(candidate.slot_hours)!==20)return{ok:false,code:"secondary_20h_ai_disabled"};
 const ids=[candidate.contact_id,candidate.conversation_id,candidate.sender_id,candidate.inbound_id]
   .map(Number);
 if(ids.some(n=>!Number.isSafeInteger(n)||n<1))return{ok:false,code:"secondary_20h_context_invalid"};
 let rows;
 try{
   const result=await database.query(CONTEXT_SQL,[
     ids[0],ids[1],ids[2],env.WHATSAPP_SECONDARY_SENDER_KEY,
     env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   ]);
   rows=result.rows||[];
 }catch{return{ok:false,code:"secondary_20h_context_unavailable"};}
 if(!rows.length || !rows.some(m=>Number(m.id)===ids[3]&&m.role==="user"))
   return{ok:false,code:"secondary_20h_anchor_missing"};
 const context=rows.slice().reverse();
 const latestUser=context.filter(m=>m.role==="user").at(-1);
 if(Number(latestUser?.id)!==ids[3])
   return{ok:false,code:"secondary_20h_customer_replied"};
 const lead=rows[0].lead||{};
 let decision;
 try{
   decision=await generate({
     conversation:context,triggerMessageId:ids[3],stepNumber:3,
     treatmentInterest:clean(lead.treatment_interest),
     stageName:clean(lead.stage_name),
     branchName:clean(lead.branch_name),
     appointmentStatus:clean(lead.appointment_status),
     instruction:"Second WhatsApp number; 20-hour follow-up. Reply naturally in the customer's language. Prioritize a free 1-to-1 posture assessment and experience when appropriate. No prices unless the customer explicitly asks. Do not repeat previous reminders or claim an appointment was confirmed. Keep concise. If uncertain or inappropriate, skip.",
     channel:"whatsapp",contactId:ids[0],leadId:lead.id||null,env,
   });
 }catch{return{ok:false,code:"secondary_20h_ai_unavailable"};}
 const message=clean(decision?.message);
 if(decision?.action!=="send" || !allowedMessage(message,context))
   return{ok:false,code:"secondary_20h_ai_skipped"};
 return{ok:true,message,mode:"ai_personalized"};
}
module.exports={CONTEXT_SQL,allowedMessage,createPersonalized20h};
