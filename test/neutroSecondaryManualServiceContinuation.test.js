"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const service=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const automation=require("../src/services/whatsappSecondaryAdsOnlyEligibility");

test("one-time continuation is restricted to 2h after a verified staff question",()=>{
 for(const sql of [service.CANDIDATES_SQL,service.RECHECK_SQL,service.POTENTIAL_DUE_SQL]){
  assert.match(sql,/whatsapp_secondary_manual_service_followup_continuations approved/);
  assert.match(sql,/rule\.slot_hours=2/);
  assert.match(sql,/first_reply\.staff_reply=TRUE/);
  assert.match(sql,/first_reply\.staff_question=TRUE/);
  assert.match(sql,/approved\.staff_message_id=first_reply\.id/);
  assert.match(sql,/approved\.anchor_message_id=inbound\.id/);
  assert.match(sql,/staff\.created_at>=c\.whatsapp_secondary_manual_ai_approved_at/);
  assert.match(sql,/approved\.approved_at>=staff\.created_at/);
  assert.match(sql,/approved\.expires_at>NOW\(\)\+INTERVAL '2 minutes'/);
  assert.match(sql,/approved\.expires_at<=inbound\.source_created_at\+INTERVAL '24 hours'/);
  assert.match(sql,/genuine_ad\.source_type='ad'/);
  assert.match(sql,/staff\.delivery_status IN \('sent','delivered','read'\)/);
  assert.match(sql,/whatsapp_sender_message_context staff_context/);
  assert.match(sql,/whatsapp_sender_coexistence_history_messages historical/);
  assert.match(sql,/c\.whatsapp_coexistence_imported_at IS NULL/);
  assert.match(sql,/c\.takeover_by IS NULL/);
  assert.match(sql,/c\.whatsapp_opt_out_at IS NULL/);
  assert.match(sql,/c\.whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(sql,/INTERVAL '8 hours'/);
 }
});
test("no marketing or general automation consent is granted by the continuation",()=>{
 assert.doesNotMatch(marketing.CANDIDATES_SQL,/manual_service_followup_continuations/);
 assert.doesNotMatch(automation.secondaryAutomationEligibleSql("c","$6","inbound","$7","$8",{}),
  /manual_service_followup_continuations/);
 assert.match(service.CANDIDATES_SQL,/COALESCE\(lead\.marketing_consent,'unknown'\)<>'opted_out'/);
 assert.match(service.RECHECK_SQL,/COALESCE\(latest_lead\.marketing_consent,'unknown'\)<>'opted_out'/);
 assert.match(service.CANDIDATES_SQL,/previous_step\.completed_at IS NOT NULL/);
 assert.match(service.RECHECK_SQL,/previous_step\.completed_at IS NOT NULL/);
});
