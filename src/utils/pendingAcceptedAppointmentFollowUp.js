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
                  (to_jsonb(booking_acceptance)->>'id')::bigint)))
  )`;
}
module.exports = { pendingAcceptedAppointmentAllowedSql };
