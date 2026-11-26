const test=require("node:test");
const assert=require("node:assert/strict");
const {pendingAcceptedAppointmentAllowedSql}=require("../src/utils/pendingAcceptedAppointmentFollowUp");
test("booking follow-ups stop for rescheduling and unresolved reviews",()=>{
 const sql=pendingAcceptedAppointmentAllowedSql("c");
 assert.match(sql,/appointment_status,'none'\) = 'reschedule'/);
 assert.match(sql,/staff_time_accepted/);
 assert.match(sql,/staff_appointment_reminder/);
 assert.match(sql,/booking_ready/);
 assert.match(sql,/booking_hold_resolved/);
 assert.match(sql,/to_jsonb\(booking_resolution\)/);
 assert.throws(()=>pendingAcceptedAppointmentAllowedSql("contact alias"),/alias/);
});

test("Neutro sales eligibility honors persisted decline or deferral in shared SQL",()=>{
 const config=require("../src/config/clinicConfig");
 const original={businessType:config.businessType,businessName:config.businessName,aiPricingIntentMode:config.aiPricingIntentMode};
 try{
  Object.assign(config,{businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"});
  const sql=pendingAcceptedAppointmentAllowedSql("c");
  assert.match(sql,/customer_sales_followup_state/);
  assert.match(sql,/NOT IN \('declined','deferred'\)/);
  assert.match(sql,/whatsapp_customer_mutation/);
 }finally{Object.assign(config,original);}
});
