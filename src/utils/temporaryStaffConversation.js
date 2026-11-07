"use strict";
// Reused by live reply handling and every sender's follow-up send checks.
// Brief staff-led appointment coordination is not the same as a broadcast
// greeting, promotion, media upload or historical staff chat.
function temporaryStaffConversationSql(contact="c",inbound="inbound",{appointmentOnly=false}={}){
 for(const alias of [contact,inbound]){
  if(!/^[a-z][a-z0-9_]*$/iu.test(alias))throw new TypeError("Invalid SQL alias");
 }
 // The durable, verified staff reminder signal also covers natural messages
 // that do not contain the literal words "appointment" or "booking".
 const persistedReminder = `EXISTS (
   SELECT 1 FROM lead_activities reminder
   JOIN leads reminder_lead ON reminder_lead.id=reminder.lead_id
   WHERE reminder_lead.contact_id=staff.contact_id
     AND reminder.metadata->>'outcome'='staff_appointment_reminder'
     AND reminder.metadata->>'staffMessageId'=staff.id::text
     AND NOT EXISTS (
       SELECT 1 FROM lead_activities resolved
       WHERE resolved.lead_id=reminder.lead_id
         AND resolved.metadata->>'outcome'='booking_hold_resolved'
         AND resolved.id>reminder.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM lead_activities invalidated
       WHERE invalidated.lead_id=reminder.lead_id
         AND invalidated.metadata->>'outcome'='staff_reminder_invalidated'
         AND invalidated.metadata->>'staffMessageId'=staff.id::text
         AND invalidated.id>reminder.id
     )
 )`;
 // The ordinary staff-question hold remains a sales follow-up safeguard,
 // but never silently suppress the next direct AI answer. Direct replies only
 // pause for a verified reminder or an active, explicitly booking-related
 // exchange between this customer and authenticated staff.
 const activeBookingExchange = `(
   COALESCE(staff.content,'') ~* '((^|[^[:alpha:]])(appointment|appointments|booking|booked|reschedule|rescheduling|time[[:space:]]+slot|temujanji|janji[[:space:]]+temu)([^[:alpha:]]|$)|预约|預約|约时间|約時間|改期|改约|改約|时段|時段)'
   AND EXISTS (
     SELECT 1 FROM messages previous_customer
     WHERE previous_customer.contact_id=staff.contact_id
       AND previous_customer.role='user'
       AND (previous_customer.created_at,previous_customer.id)<(staff.created_at,staff.id)
       AND previous_customer.created_at>=staff.created_at-INTERVAL '30 minutes'
       AND COALESCE(previous_customer.content,'') ~* '((^|[^[:alpha:]])(book|booking|appointment|appointments|slot|schedule|reschedule|availability|available|visit|tomorrow|can[[:space:]]+i[[:space:]]+come|temujanji|janji[[:space:]]+temu|boleh[[:space:]]+datang)([^[:alpha:]]|$)|预约|預約|约时间|約時間|改期|改约|改約|明天|后天|後天|可以过来|可以過來|来店|來店|到店)'
   )
 )`;
 const conversationEvidence = appointmentOnly
   ? `(${persistedReminder} OR ${activeBookingExchange})`
   : `(
      COALESCE(staff.content,'') ~ '[?？]'
      OR COALESCE(staff.content,'') ~* '(confirm|comfirm|confirmed|booked|booking|appointment|预约|預約|确认|確認|已安排|slot|时段|時段|can[[:space:]]+[0-9]{1,2}([:.][0-9]{2})?[[:space:]]*(am|pm))'
      OR ${persistedReminder}
    )`;
 return `EXISTS (
  SELECT 1 FROM messages staff
  WHERE staff.contact_id=${contact}.id
    AND staff.role='assistant'
    AND staff.sent_by_username IS NOT NULL
    AND staff.sent_by_username<>'Follow-up automation'
    AND staff.whatsapp_message_id IS NOT NULL
    AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
    AND COALESCE((to_jsonb(staff)->>'is_forwarded')::boolean,FALSE)=FALSE
    AND staff.delivery_status IS DISTINCT FROM 'failed'
    AND (staff.created_at,staff.id)<(${inbound}.created_at,${inbound}.id)
    AND staff.created_at>=${inbound}.created_at-INTERVAL '2 hours'
    AND (staff.media_mime_type IS NULL OR staff.media_mime_type NOT LIKE 'image/%')
    AND COALESCE(staff.content,'') !~* '(happy[[:space:]]+birthday|birthday|生日快乐|生日快樂|complimentary[[:space:]]+treat|本月限时优惠|本月限時優惠)'
    AND ${conversationEvidence}
    AND (
      EXISTS (
        SELECT 1 FROM messages previous_customer
        WHERE previous_customer.contact_id=staff.contact_id
          AND previous_customer.role='user'
          AND (previous_customer.created_at,previous_customer.id)<(staff.created_at,staff.id)
          AND previous_customer.created_at>=staff.created_at-INTERVAL '30 minutes'
      )
      OR ${persistedReminder}
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages ai
      WHERE ai.contact_id=staff.contact_id AND ai.role='assistant'
        AND ai.sent_by_username IS NULL
        AND ai.is_automated_follow_up IS DISTINCT FROM TRUE
        AND (ai.created_at,ai.id)>(staff.created_at,staff.id)
        AND (ai.created_at,ai.id)<(${inbound}.created_at,${inbound}.id)
    )
 )`;
}
module.exports={temporaryStaffConversationSql};
