"use strict";
// One-off reconciliation. No worker, no provider calls, no automatic CRM
// writes. An operator must specify the exact lead and authenticated message.
const {verifiedStaffSlot,isTerseBookingCorroborated}=require("./staffBookingConfirmationService");
const {appointmentRecognitionEnabled}=require("../utils/aiLedAppointmentEvidence");

const RECOVERY_SQL=`
SELECT l.id AS lead_id,l.contact_id,l.appointment_status,l.appointment_at,l.is_closed,l.updated_at,
       staff.id AS staff_message_id,staff.content AS staff_text,staff.created_at AS staff_at,
       (SELECT max(m.id) FROM messages m WHERE m.contact_id=l.contact_id) AS latest_message_id,
       COALESCE((SELECT jsonb_agg(to_jsonb(turn) ORDER BY turn.id DESC)
         FROM (SELECT m.id,m.role,m.content,m.sent_by_username,m.created_at,m.is_forwarded,
           m.is_automated_follow_up,m.whatsapp_customer_mutation,m.media_mime_type,
           m.media_url,m.delivery_status,m.whatsapp_message_id
           FROM messages m WHERE m.contact_id=l.contact_id AND m.id<staff.id
           AND m.created_at>=staff.created_at-INTERVAL '7 days'
           ORDER BY m.id DESC LIMIT 50) turn),'[]'::jsonb) AS prior_turns,
       COALESCE((SELECT jsonb_agg(to_jsonb(turn) ORDER BY turn.id)
         FROM (SELECT m.id,m.role,m.content,m.sent_by_username,m.created_at,m.is_forwarded,
           m.is_automated_follow_up,m.whatsapp_customer_mutation,m.media_mime_type,
           m.media_url,m.delivery_status,m.whatsapp_message_id
           FROM messages m WHERE m.contact_id=l.contact_id AND m.id>staff.id
           ORDER BY m.id LIMIT 101) turn),'[]'::jsonb) AS later_turns
FROM leads l JOIN messages staff ON staff.contact_id=l.contact_id
WHERE l.id=$1 AND staff.id=$2 AND l.is_closed=false
  AND COALESCE(l.appointment_status,'none')='none' AND l.appointment_at IS NULL
  AND staff.created_at>=l.created_at AND staff.created_at>=NOW()-INTERVAL '30 days'
  AND staff.role='assistant' AND staff.sent_by_username IS NOT NULL
  AND staff.sent_by_username NOT IN ('Follow-up automation','Consent request automation')
  AND staff.whatsapp_message_id LIKE 'wamid.%'
  AND staff.whatsapp_customer_mutation IS NULL AND staff.is_forwarded IS DISTINCT FROM TRUE
  AND staff.is_automated_follow_up IS DISTINCT FROM TRUE AND staff.media_mime_type IS NULL AND staff.media_url IS NULL
  AND COALESCE(staff.delivery_status,'pending') NOT IN ('failed','unknown','cancelled')
  AND NOT EXISTS(SELECT 1 FROM leads newer WHERE newer.contact_id=l.contact_id
    AND (newer.created_at,newer.id)>(l.created_at,l.id))
  AND NOT EXISTS(SELECT 1 FROM lead_activities a WHERE a.lead_id=l.id
    AND a.created_at>=staff.created_at AND a.metadata->>'outcome'='booking_hold_resolved')`;

function reviewRecovery(row,config,now=new Date()){
  if(!row||!appointmentRecognitionEnabled(config)||row.is_closed||
    !["none",null].includes(row.appointment_status)||row.appointment_at)return null;
  const text=String(row.staff_text||"");
  // Historical auto-write requires actual staff confirmation and independent
  // customer agreement. Never infer it from an assistant or a reminder alone.
  if(!/^(?:confirm(?:ed)?|comfirm(?:ed)?)\s+(?:appointment|booking)\b|(?:预约|預約)(?:已确认|已確認|确认成功|確認成功)/iu.test(text.trim())||
    /[?？]|\b(?:not|maybe|pending|if|cancel)\b|待确认|待確認|取消|尚未/iu.test(text))return null;
  const slot=verifiedStaffSlot(text,new Date(row.staff_at),now,config.hours);
  if(!slot||!isTerseBookingCorroborated(text,slot,row.prior_turns,row.staff_at))return null;
  if(!Array.isArray(row.later_turns)||row.later_turns.length>100)return null;
  for(const t of row.later_turns){
    if(t.role!=="user"&&!t.sent_by_username)continue;
    if(t.is_automated_follow_up||["Follow-up automation","Consent request automation"].includes(t.sent_by_username))continue;
    const value=String(t.content||"");
    if(/\b(?:cancel\w*|reschedul\w*|cannot|can['’]t|not coming|not available|tukar|batal)\b|取消|改期|改时间|改時間|不去了|不来了|不來了|不方便|不能来|不能來/iu.test(value))return null;
    const newer=verifiedStaffSlot(value,new Date(t.created_at),new Date(t.created_at),null,{allowUnconfigured:true});
    if(newer&&newer!==slot)return null;
    // Any new calendar/clock fragment or unclear change is for manual review.
    if(!newer&&/(?:\b\d{1,2}[/-]\d{1,2}\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|星期[一二三四五六日天]|(?:上午|下午|早上|晚上)\s*\d)/iu.test(value))return null;
  }
  return {leadId:Number(row.lead_id),contactId:Number(row.contact_id),staffMessageId:Number(row.staff_message_id),appointmentAt:slot,
    expectedBookingRecovery:{contactId:Number(row.contact_id),staffMessageId:Number(row.staff_message_id),staffText:text,latestMessageId:Number(row.latest_message_id),updatedAt:row.updated_at}};
}
async function reconcileStaffAppointment({database,pipeline,config,leadId,staffMessageId,apply=false,now=new Date()}={}){
  if(![leadId,staffMessageId].every(id=>Number.isSafeInteger(id)&&id>0))throw new TypeError("Exact lead and staff message IDs required");
  const result=await database.query(RECOVERY_SQL,[leadId,staffMessageId]);
  const plan=reviewRecovery(result.rows[0],config,now);
  if(!plan)return {status:"manual_review_required"};
  const summary={leadId:plan.leadId,staffMessageId:plan.staffMessageId,appointmentAt:plan.appointmentAt};
  if(!apply)return {status:"verified_dry_run",...summary};
  const updated=await pipeline.updateLead(leadId,{appointmentStatus:"set",appointmentAt:plan.appointmentAt},
    "Verified staff appointment reconciliation",{expectedBookingRecovery:plan.expectedBookingRecovery});
  return {status:updated?"reconciled":"evidence_changed",...summary};
}
module.exports={RECOVERY_SQL,reviewRecovery,reconcileStaffAppointment};
