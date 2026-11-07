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
 // Natural appointment coordination rarely repeats the word "booking".
 // Require two-party booking evidence plus a concrete day AND time,
 // including terse offers such as "Tomorrow 3pm?" or "周六下午3点?".
 const naturalStaffTimeOffer = `(
   COALESCE(staff.content,'') ~* '(tomorrow|tmr|today|this[[:space:]]+(mon|tue|wed|thu|fri|sat|sun)|next[[:space:]]+(mon|tue|wed|thu|fri|sat|sun)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|esok|hari[[:space:]]+ini|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|明天|后天|後天|星期[一二三四五六日天]|[这這本下]?[周週][一二三四五六日天]|[0-9]{1,2}[/-][0-9]{1,2})'
   AND COALESCE(staff.content,'') ~* '(([01]?[0-9]|2[0-3])[:.][0-5][0-9]|(0?[1-9]|1[0-2])[[:space:]]*(am|pm)|(?:上午|下午|早上|晚上|傍晚)[[:space:]]*[0-9一二三四五六七八九十]{1,3}[点點]|[0-9一二三四五六七八九十]{1,3}[点點])'
 )`;
 // A newer, explicitly unrelated service question releases only the
 // direct-reply hold. It cannot resolve an actual booking or schedule.
 // "How much?" alone stays with the booking staff because it is ambiguous.
 const newTreatmentTopic = `(
   COALESCE(${inbound}.content,'') ~* '((^|[^[:alnum:]])(3[[:space:]]*d|9[[:space:]]*d|facial|face[[:space:]]*care|pelvic|posture|pulse[[:space:]]*wave|device|machine|treatment|treatments|services|rawatan|mesin|alat)([^[:alnum:]]|$)|小颜|小顏|逆龄|逆齡|骨盆|脉冲|脈衝|脸部|臉部|仪器|儀器|疗程|療程|护理|護理)'
   AND COALESCE(${inbound}.content,'') !~* '((^|[^[:alpha:]])(book|booking|booked|appointment|appointments|slot|reschedul(e|ing)|schedule|reserve|visit|come|arrive|tomorrow|tmr|today|date|time|cancel|temujanji|janji[[:space:]]*temu|esok)([^[:alpha:]]|$)|预约|預約|订位|訂位|明天|后天|後天|周[一二三四五六日天]|週[一二三四五六日天]|星期[一二三四五六日天]|改期|取消|时间|時間|时段|時段|到店|过来|過來)'
 )`;
 const activeBookingExchange = `(
   (COALESCE(staff.content,'') ~* '((^|[^[:alpha:]])(appointment|appointments|booking|booked|reschedule|rescheduling|time[[:space:]]+slot|temujanji|janji[[:space:]]+temu)([^[:alpha:]]|$)|预约|預約|约时间|約時間|改期|改约|改約|时段|時段)' OR ${naturalStaffTimeOffer})
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
   ? `((${persistedReminder} OR ${activeBookingExchange}) AND NOT ${newTreatmentTopic})`
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
