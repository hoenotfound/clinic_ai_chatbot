"use strict";

// Independent, opt-in-only sender follow-ups. These messages never enter
// Neutro's follow-up queue, template billing, retry worker or media ID cache.
// A claimed slot is one-shot even after timeout, worker crash or uncertain
// provider acceptance. Nothing sends while either flag or rules are disabled.
const {pool}=require("../db/db");
const messagesRepo=require("../db/messagesRepo");
const contactsRepo=require("../db/contactsRepo");
const mediaStorage=require("./mediaStorageService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");

const SLOTS=new Set([2,6,20]);
const MAX_MEDIA=16*1024*1024;
const INTERVAL=5*60*1000;
const ALLOWED_MIME={
  video:new Set(["video/mp4","video/3gpp"]),
  image:new Set(["image/jpeg","image/png"]),
  audio:new Set(["audio/ogg","audio/mpeg","audio/mp4","audio/aac"]),
};
const CANDIDATES_SQL=`
 SELECT c.id AS contact_id,c.channel,c.whatsapp_number,c.whatsapp_sender_id,
   sa.sender_key AS whatsapp_sender_key,
   sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
   sa.meta_account_id AS whatsapp_sender_account_id,
   sc.id AS conversation_id,
   inbound.id AS inbound_id,inbound.created_at AS inbound_at,
   rule.sender_id,rule.slot_hours,rule.message_text,rule.media_key,
   rule.media_type,rule.media_mime_type,rule.media_filename,
   rule.updated_at AS rule_updated_at
 FROM whatsapp_sender_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.state='active' AND sa.sender_key=$1
   AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.state='bound'
 JOIN contacts c ON c.id=sc.contact_id AND c.whatsapp_sender_id=sa.id
   AND c.channel='whatsapp' AND c.whatsapp_number=sc.customer_wa_id
 JOIN LATERAL (
   SELECT m.id,m.created_at FROM messages m
   JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
     AND mc.conversation_id=sc.id
   WHERE m.contact_id=c.id AND m.role='user'
     AND m.whatsapp_message_id IS NOT NULL
   ORDER BY m.created_at DESC,m.id DESC LIMIT 1
 ) inbound ON true
 LEFT JOIN LATERAL (
   SELECT lead.marketing_consent,lead.is_closed,lead.appointment_status,
     stage.system_key AS stage_key
   FROM leads lead LEFT JOIN pipeline_stages stage ON stage.id=lead.stage_id
   WHERE lead.contact_id=c.id ORDER BY lead.is_closed ASC,lead.created_at DESC,lead.id DESC
   LIMIT 1
 ) lead ON true
 WHERE rule.enabled=TRUE
   AND rule.slot_hours IN(2,6,20)
   AND c.mode='ai' AND c.needs_attention=FALSE
   AND c.whatsapp_opt_in_at IS NOT NULL
   AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND lead.marketing_consent='opted_in'
   AND lead.is_closed=FALSE
   AND COALESCE(lead.appointment_status,'none') NOT IN('set','visited')
   AND COALESCE(lead.stage_key,'') NOT IN('appointment_set','visited')
   AND EXTRACT(HOUR FROM ($4::timestamptz AT TIME ZONE 'Asia/Kuala_Lumpur'))
       BETWEEN 7 AND 23
   AND inbound.created_at + rule.slot_hours * INTERVAL '1 hour' <= $4::timestamptz
   AND inbound.created_at + (rule.slot_hours + 1) * INTERVAL '1 hour' > $4::timestamptz
   AND inbound.created_at > $4::timestamptz - INTERVAL '24 hours'
   AND EXISTS (
     SELECT 1 FROM messages reply JOIN whatsapp_sender_message_context mc
       ON mc.message_id=reply.id AND mc.conversation_id=sc.id
     WHERE reply.contact_id=c.id AND reply.role='assistant'
       AND reply.whatsapp_message_id IS NOT NULL
       AND reply.sent_by_username IS NULL
       AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
       AND reply.created_at>=inbound.created_at
   )
   AND NOT EXISTS (
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND human.created_at>=inbound.created_at
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_attempts previous
     WHERE previous.sender_id=sa.id AND previous.contact_id=c.id
       AND previous.anchor_message_id=inbound.id
       AND previous.status IN('unknown','blocked')
   )
   AND NOT EXISTS (
     SELECT 1 FROM whatsapp_sender_followup_attempts attempted
     WHERE attempted.sender_id=sa.id AND attempted.contact_id=c.id
       AND attempted.anchor_message_id=inbound.id
       AND attempted.slot_hours=rule.slot_hours
   )
 ORDER BY inbound.created_at,c.id,rule.slot_hours
 LIMIT $5
`;

function enabled(env) {
 return env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AI_SEND_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
   env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true";
}

const RECHECK_SQL=`
 SELECT EXISTS (
 SELECT 1 FROM whatsapp_sender_followup_rules rule
 JOIN whatsapp_sender_accounts sa ON sa.id=rule.sender_id
   AND sa.sender_key=$4 AND sa.meta_phone_number_id=$5
   AND sa.meta_account_id=$6 AND sa.state='active'
 JOIN contacts c ON c.id=$1 AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
   AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
 JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
   AND mc.conversation_id=sc.id
 JOIN whatsapp_sender_followup_attempts attempt ON
   attempt.sender_id=sa.id AND attempt.contact_id=c.id
   AND attempt.anchor_message_id=inbound.id
   AND attempt.slot_hours=$3 AND attempt.status='claimed'
 WHERE rule.sender_id=sa.id AND rule.slot_hours=$3 AND rule.enabled
   AND rule.updated_at=$7::timestamptz
   AND c.mode='ai' AND c.needs_attention=FALSE
   AND c.whatsapp_opt_in_at IS NOT NULL AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND EXISTS(
     SELECT 1 FROM leads l WHERE l.contact_id=c.id
       AND l.marketing_consent='opted_in' AND l.is_closed=FALSE
       AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited')
   )
   AND NOT EXISTS(
     SELECT 1 FROM messages newer
     WHERE newer.contact_id=c.id AND newer.role='user'
       AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
   )
   AND NOT EXISTS(
     SELECT 1 FROM messages human
     WHERE human.contact_id=c.id AND human.role='assistant'
       AND human.sent_by_username IS NOT NULL
       AND human.created_at>=inbound.created_at
   )
   AND inbound.created_at + INTERVAL '24 hours' > NOW() + INTERVAL '2 minutes'
   AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
 ) AS allowed`;

async function runOnce({
  database=pool,env=process.env,
  now=new Date(),limit=10,
  sendText=sendSecondaryStaffText,
  store=messagesRepo,storage=mediaStorage,contacts=contactsRepo,
}={}) {
  if (!enabled(env))return{disabled:true,attempted:0,accepted:0};
  const allowedLimit=Math.max(1,Math.min(20,Number(limit)||10));
  const items=(await database.query(CANDIDATES_SQL,[
    env.WHATSAPP_SECONDARY_SENDER_KEY,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID,now,allowedLimit,
  ])).rows||[];
  let attempted=0,accepted=0;
  for(const candidate of items) {
    const slot=Number(candidate.slot_hours);
    if(!SLOTS.has(slot) || !Number.isSafeInteger(Number(candidate.contact_id)))continue;
    // Atomic unique one-shot claim across Render worker instances.
    const claimed=await database.query(
      `INSERT INTO whatsapp_sender_followup_attempts
        (sender_id,contact_id,anchor_message_id,slot_hours)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [candidate.sender_id,candidate.contact_id,candidate.inbound_id,slot]
    );
    const id=claimed.rows?.[0]?.id;
    if(!id)continue;
    attempted++;
    let messageId=null;
    const fail=async(code)=>{
      await database.query(
        "UPDATE whatsapp_sender_followup_attempts SET status='unknown',error_code=$2,completed_at=NOW() WHERE id=$1 AND status='claimed'",
        [id,String(code||"unknown").slice(0,120)]
      );
    };
    const preSendCheck=async()=>{
      const result=await database.query(RECHECK_SQL,[
        candidate.contact_id,candidate.inbound_id,slot,
        env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        env.WHATSAPP_SECONDARY_WABA_ID,
        candidate.rule_updated_at,
      ]);
      return result.rows?.[0]?.allowed===true;
    };
    try {
      if(!await preSendCheck()){await fail("sender_followup_policy_changed");continue;}
      const key=candidate.media_key;
      let bytes=null;
      if(key){
        const mime=candidate.media_mime_type;
        const kind=candidate.media_type;
        const filename=candidate.media_filename;
        if(!ALLOWED_MIME[kind]?.has(mime) ||
          !/^[A-Za-z0-9._ -]{1,180}$/.test(String(filename||""))){
          await fail("sender_followup_media_invalid");continue;
        }
        bytes=await storage.downloadMedia(key,{maxBytes:MAX_MEDIA});
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA){
          await fail("sender_followup_media_unavailable");continue;
        }
      }
      const contact=await contacts.getContactById(candidate.contact_id);
      if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
         String(contact.whatsapp_sender_id)!==String(candidate.sender_id)){
        await fail("sender_followup_owner_changed");continue;
      }
      const saved=await store.saveMessage(candidate.contact_id,
        "assistant",candidate.message_text,null,null,null,null,
        key?candidate.media_mime_type:null,{
          whatsappTemplate:{automatedSecondaryFollowup:true,
            senderKey:env.WHATSAPP_SECONDARY_SENDER_KEY,
            slotHours:slot,anchorMessageId:candidate.inbound_id},
          isAutomatedFollowUp:true,mediaKey:key||null,
          mediaFilename:key?candidate.media_filename:null,
          initialDeliveryStatus:"unknown",
          initialDeliveryError:"Sender-scoped follow-up attempted; provider delivery not confirmed.",
        });
      messageId=saved.id;
      await database.query(
        "UPDATE whatsapp_sender_followup_attempts SET message_id=$2 WHERE id=$1",
        [id,messageId]
      );
      const result=await sendText({
        contact,messageId,text:candidate.message_text,
        origin:"followup",preSendCheck,
        ...(bytes?{dispatchTransport:async transport=>{
          const uploaded=await transport.uploadMedia(bytes,
            candidate.media_mime_type,candidate.media_filename);
          if(!uploaded?.success || !uploaded.mediaId)return{
            success:false,ambiguous:true,retryable:false,
          };
          if(!await preSendCheck())return{
            success:false,ambiguous:true,retryable:false,
          };
          return transport.sendMediaById(candidate.media_type,
            uploaded.mediaId,{caption:candidate.message_text,
              filename:candidate.media_filename,voice:candidate.media_type==="audio"});
        }}:{}),
      },{env,database});
      if(result?.success===true && /^wamid\./.test(String(result.wamid||""))) {
        await store.setWhatsappMessageId(messageId,result.wamid);
      }
      if(result?.success===true && result?.unknown!==true &&
         /^wamid\./.test(String(result.wamid||""))) {
        await database.query(
          "UPDATE whatsapp_sender_followup_attempts SET status='accepted',wamid=$2,completed_at=NOW() WHERE id=$1",
          [id,result.wamid]
        );
        accepted++;
      } else await fail(result?.code||"sender_followup_delivery_unconfirmed");
    }catch{
      await fail("sender_followup_processing_unconfirmed").catch(()=>{});
    }
  }
  return {disabled:false,attempted,accepted};
}

let timer=null;
function start({env=process.env,setIntervalFn=setInterval,run=runOnce}={}) {
 if(!enabled(env)||timer)return false;
 timer=setIntervalFn(()=>run({env}).catch(e=>
   console.error("[Ariel followups] Sender-scoped worker error:",e?.message)
 ),INTERVAL);
 timer?.unref?.();
 return true;
}
function stop(){if(timer){clearInterval(timer);timer=null;}}
module.exports={CANDIDATES_SQL,RECHECK_SQL,enabled,runOnce,start,stop};
