// A customer's acceptance of a verified STAFF-offered slot is a pending
// agreement, not an appointment confirmation. Still, stop promotional
// follow-ups until staff resolves it. A later lead or explicit cancellation
// or reschedule on that lead may start a fresh enquiry.
const clinicConfig = require("../config/clinicConfig");
function pendingAcceptedAppointmentAllowedSql(contactAlias = "c") {
  if (!/^[a-z][a-z0-9_]*$/iu.test(contactAlias)) throw new Error("Invalid contact SQL alias");
  if (!["aesthetic_clinic","tcm_clinic"].includes(clinicConfig.businessType)) return "TRUE";
  return `NOT EXISTS (
    SELECT 1 FROM leads booking_lead
    LEFT JOIN lead_activities booking_acceptance ON booking_acceptance.lead_id=booking_lead.id
    WHERE booking_lead.id=(
      SELECT latest_booking_lead.id FROM leads latest_booking_lead
      WHERE latest_booking_lead.contact_id=${contactAlias}.id
      ORDER BY latest_booking_lead.created_at DESC, latest_booking_lead.id DESC
      LIMIT 1
    )
      AND (COALESCE(booking_lead.appointment_status,'none') = 'reschedule'
        OR (booking_acceptance.metadata->>'outcome' IN ('staff_time_accepted','booking_ready','staff_visit_acknowledged','booking_intent_pending','staff_appointment_reminder')
          AND COALESCE(booking_lead.appointment_status,'none') <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM lead_activities booking_resolution
            WHERE booking_resolution.lead_id=booking_lead.id
              AND booking_resolution.metadata->>'outcome'='booking_hold_resolved'
              AND (to_jsonb(booking_resolution)->>'id')::bigint >
                  (to_jsonb(booking_acceptance)->>'id')::bigint)
          AND (
            booking_acceptance.metadata->>'outcome' <> 'staff_appointment_reminder'
            OR (
              -- A reminder is a temporary SALES hold, not a booked CRM slot.
              -- Never wake an old follow-up sequence solely because this
              -- protection expires. Existing due-time/24h/66h gates still apply.
              COALESCE((to_jsonb(booking_acceptance)->>'created_at')::timestamptz, NOW()) >= NOW() - INTERVAL '30 days'
              AND NOT EXISTS (
                SELECT 1 FROM messages reminder_source
                JOIN messages fresh_interest
                  ON fresh_interest.contact_id=reminder_source.contact_id
                WHERE reminder_source.id =
                  NULLIF(booking_acceptance.metadata->>'staffMessageId','')::integer
                  AND reminder_source.contact_id=booking_lead.contact_id
                  AND reminder_source.role='assistant'
                  AND NULLIF(to_jsonb(reminder_source)->>'whatsapp_message_id','') IS NOT NULL
                  AND fresh_interest.role='user'
                  AND NULLIF(to_jsonb(fresh_interest)->>'whatsapp_message_id','') IS NOT NULL
                  AND COALESCE((to_jsonb(fresh_interest)->>'is_forwarded')::boolean,false) = false
                  AND NULLIF(to_jsonb(fresh_interest)->>'media_mime_type','') IS NULL
                  -- The first 72 hours are kept for the original appointment.
                  -- Only a later, EXPLICIT new treatment enquiry reopens sales.
                  AND fresh_interest.created_at >=
                      reminder_source.created_at + INTERVAL '72 hours'
                  AND fresh_interest.created_at >= NOW() - INTERVAL '7 days'
                  AND fresh_interest.content ~*
                    '(3[[:space:]]*d|9[[:space:]]*d|pelvic|pulse[[:space:]]*wave|moxibustion|facial|骨盆|脉冲|脈衝|小颜|小顏|逆龄|逆齡|艾灸)'
                  AND fresh_interest.content ~*
                    '(interested|want[[:space:]]+to[[:space:]]+(know|try|ask)|like[[:space:]]+to[[:space:]]+know|how[[:space:]]+much|price[[:space:]]+for|enquir|new[[:space:]]+treatment|我想了解|想了解|我要做|请问|請問|多少钱|多少錢|nak[[:space:]]+tahu|nak[[:space:]]+tanya|berapa[[:space:]]+harga|saya[[:space:]]+nak)'
                  AND fresh_interest.content !~*
                    '(appointment|booking|tomorrow|tmr|prepare|aftercare|reschedul|cancel|预约|預約|准备|準備|改期|取消|复诊|複診)'
              )
            )
          )))
  )`;
}
module.exports = { pendingAcceptedAppointmentAllowedSql };
