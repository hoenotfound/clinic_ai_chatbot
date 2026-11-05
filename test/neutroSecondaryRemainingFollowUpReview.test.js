"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");

test("48h/66h marketing checks keep sender, consent and latest customer intent",()=>{
 for(const sql of [marketing.CANDIDATES_SQL,marketing.RECHECK_SQL]){
   assert.match(sql,/m\.content AS last_customer_text/);
   assert.match(sql,/inbound\.last_customer_text/);
   assert.match(sql,/谢谢/);
   assert.match(sql,/health\[\[:space:\]\]\+professional/);
   assert.match(sql,/penang/);
   assert.match(sql,/consent\.consent_scope='treatment_followups_and_related_offers'/);
   assert.match(sql,/whatsapp_sender_coexistence_history_messages/);
   assert.match(sql,/booking_lead/);
 }
 assert.match(marketing.CANDIDATES_SQL,/rule\.slot_hours IN\(48,66\)/);
 assert.match(marketing.RECHECK_SQL,/attempted\.status='claimed'/);
});
test("Day4/Day6 keep same intent check and their separate billing controls",()=>{
 for(const sql of [marketing.EXTENDED_CANDIDATES_SQL,marketing.EXTENDED_RECHECK_SQL]){
   assert.match(sql,/inbound\.last_customer_text/);
   assert.match(sql,/business\[\[:space:\]\]\+\(collaboration\|partnership\)/);
   assert.match(sql,/qualified_session\.first_reply_at/);
   assert.match(sql,/consent\.consent_scope='treatment_followups_and_related_offers'/);
   assert.match(sql,/whatsapp_sender_billing_alarms/);
 }
 assert.match(marketing.EXTENDED_RECHECK_SQL,/attempted\.status='claimed'/);
});
test("read-only staff screen exposes expired unsent images and uncertain followups",()=>{
 const route=fs.readFileSync(path.join(__dirname,"../src/routes/whatsappSecondaryMediaReview.js"),"utf8");
 const ui=fs.readFileSync(path.join(__dirname,"../portal-frontend/src/components/ArielMediaReview.jsx"),"utf8");
 assert.match(route,/j\.state='expired'/);
 assert.match(route,/j\.updated_at>=NOW\(\)-INTERVAL '14 days'/);
 assert.match(route,/m\.whatsapp_message_id IS NULL AND m\.whatsapp_accepted_at IS NULL/);
 assert.match(route,/whatsapp_sender_followup_attempts/);
 assert.match(route,/whatsapp_sender_marketing_followup_attempts/);
 assert.match(route,/f\.status IN\('unknown','blocked'\)/);
 assert.match(route,/outboundRetryAllowed:false/);
 assert.doesNotMatch(route,/\b(?:sendSecondaryStaffText|sendTemplate|sendMessage|sendMedia)\s*\(/);
 assert.match(ui,/item\.media_kind==="result"/);
 assert.match(ui,/outbound_marketing_followup/);
 assert.doesNotMatch(ui,/>Retry</);
});
