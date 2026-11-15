"use strict";

// Repair provider-accepted Inbox staff reminders when the initial booking
// bookkeeping fails. Never resend messages or invent a CRM booking date.
// Business App echoes have their own signed webhook replay.
const {pool}=require("../db/db");
const clinicConfig=require("../config/clinicConfig");
const {isProactiveAppointmentReminder}=require("../utils/staffAppointmentReminderText");
const {recordStaffConfirmedBooking}=require("./staffBookingConfirmationService");
const {createIdleAwareRecoveryWorker}=require("../utils/idleAwareRecoveryWorker");
const RECOVERY_SQL="SELECT m.id,m.contact_id,m.content\n FROM messages m\n JOIN contacts c ON c.id=m.contact_id AND c.channel='whatsapp'\n WHERE m.created_at>=NOW()-INTERVAL '48 hours'\n   AND m.role='assistant'\n   AND m.sent_by_username IS NOT NULL\n   AND m.sent_by_username NOT IN\n     ('WhatsApp Business App','Follow-up automation','Consent request automation')\n   AND m.whatsapp_message_id IS NOT NULL\n   AND m.is_automated_follow_up IS DISTINCT FROM TRUE\n   AND m.is_forwarded IS DISTINCT FROM TRUE\n   AND m.media_mime_type IS NULL\n   AND m.delivery_status IS DISTINCT FROM 'failed'\n   AND m.delivery_status IS DISTINCT FROM 'unknown'\n   AND m.content ~* '(appointment|booking|remind|see[[:space:]]+you|see[[:space:]]+u|tomorrow|tmr|预约|預約|明天|后天|後天|见|見|temujanji|janji[[:space:]]+temu|jumpa)'\n   AND NOT EXISTS (\n     SELECT 1 FROM lead_activities a\n     JOIN leads l ON l.id=a.lead_id AND l.contact_id=m.contact_id\n     WHERE a.metadata->>'outcome'='staff_appointment_reminder'\n       AND a.metadata->>'staffMessageId'=m.id::text\n   )\n ORDER BY m.created_at DESC,m.id DESC LIMIT 120";

async function runOnce({
  database=pool,
  recognize=isProactiveAppointmentReminder,
  record=recordStaffConfirmedBooking,
  config=clinicConfig,
}={}){
  if(!["tcm_clinic","aesthetic_clinic"].includes(config.businessType))
    return {disabled:true,scanned:0,eligible:0};
  const result=await database.query(RECOVERY_SQL);
  let eligible=0;
  for(const message of result.rows||[]){
    if(!recognize(message.content))continue;
    // The recorded source's provider WAMID, contact and forwarded flag are
    // revalidated by the idempotent hold INSERT, never by a text-only match.
    await record(message.contact_id,message.content,{
      providerAccepted:true,messageId:message.id,
    });
    eligible++;
  }
  return {disabled:false,scanned:(result.rows||[]).length,eligible};
}
let worker=null;
function wake(){return worker?.wake(0)===true;}
function start({run=runOnce,...clock}={}){
  if(!["tcm_clinic","aesthetic_clinic"].includes(clinicConfig.businessType))
    return false;
  if(worker)return false;
  worker=createIdleAwareRecoveryWorker({
    ...clock,label:"accepted Inbox appointment reminder recovery",
    run,hasPendingWork:async()=>false,
  });
  worker.start(0);
  return true;
}
function stop(){if(worker){worker.stop();worker=null;}}
module.exports={RECOVERY_SQL,runOnce,start,wake,stop};
