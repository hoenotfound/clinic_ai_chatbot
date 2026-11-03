// A customer's acceptance of a verified STAFF-offered slot is a pending
// agreement, not an appointment confirmation. Still, stop promotional
// follow-ups until staff resolves it. A later lead or explicit cancellation
// or reschedule on that lead may start a fresh enquiry.
function pendingAcceptedAppointmentAllowedSql(contactAlias = "c") {
  if (!/^[a-z][a-z0-9_]*$/iu.test(contactAlias)) throw new Error("Invalid contact SQL alias");
  return `NOT EXISTS (
    SELECT 1 FROM leads booking_lead
    JOIN lead_activities booking_acceptance ON booking_acceptance.lead_id=booking_lead.id
    WHERE booking_lead.id=(
      SELECT latest_booking_lead.id FROM leads latest_booking_lead
      WHERE latest_booking_lead.contact_id=${contactAlias}.id
      ORDER BY latest_booking_lead.created_at DESC, latest_booking_lead.id DESC
      LIMIT 1
    )
      AND booking_acceptance.metadata->>'outcome' IN ('staff_time_accepted','booking_ready','staff_visit_acknowledged')
      AND COALESCE(booking_lead.appointment_status,'none') <> 'cancelled'
  )`;
}
module.exports = { pendingAcceptedAppointmentAllowedSql };
