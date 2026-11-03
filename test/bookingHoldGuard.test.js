const test=require("node:test");
const assert=require("node:assert/strict");
const {pendingAcceptedAppointmentAllowedSql}=require("../src/utils/pendingAcceptedAppointmentFollowUp");
test("booking follow-ups stop for rescheduling and unresolved reviews",()=>{
 const sql=pendingAcceptedAppointmentAllowedSql("c");
 assert.match(sql,/appointment_status,'none'\) = 'reschedule'/);
 assert.match(sql,/staff_time_accepted/);
 assert.match(sql,/booking_ready/);
 assert.match(sql,/booking_hold_resolved/);
 assert.match(sql,/to_jsonb\(booking_resolution\)/);
 assert.throws(()=>pendingAcceptedAppointmentAllowedSql("contact alias"),/alias/);
});
