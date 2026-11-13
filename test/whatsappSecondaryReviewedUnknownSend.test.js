"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {reviewedReservationIds,reviewReservationSql,reviewedDeliveryAttentionSql,reviewedUnknownGateCandidateSql}=
  require("../src/utils/whatsappSecondaryReviewedUnknownSend");
const a="3b4d4f10-9d28-461e-b065-437a6292d69a";
const b="93559527-300e-4cef-ae51-b39430f6451f";
const env={
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"true",
 WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:a+","+b,
};

test("unreviewed, wrong sender or malformed operator allowlist fails closed",()=>{
 assert.deepEqual(reviewedReservationIds({}),[]);
 assert.deepEqual(reviewedReservationIds({...env,
   WHATSAPP_SECONDARY_UNKNOWN_GATE_NEW_SEND_BYPASS_ENABLED:"false"}),[]);
 assert.deepEqual(reviewedReservationIds({...env,
   WHATSAPP_SECONDARY_SENDER_KEY:"some_other_sender"}),[]);
 assert.deepEqual(reviewedReservationIds({...env,
   WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:a+",DROP TABLE messages"}),[]);
 assert.deepEqual(reviewedReservationIds({...env,
   WHATSAPP_SECONDARY_REVIEWED_UNKNOWN_RESERVATIONS:a+","+a}),[]);
 assert.equal(reviewReservationSql({}),"FALSE");
 assert.equal(reviewedDeliveryAttentionSql("c",{}),"FALSE");
 assert.throws(()=>reviewedDeliveryAttentionSql("c;DROP TABLE contacts",env));
});
test("only exact reservation IDs permit a fresh sender-owned enquiry past delivery attention",()=>{
 assert.deepEqual(reviewedReservationIds(env),[a,b]);
 const sql=reviewedDeliveryAttentionSql("c",env);
 for(const proof of [
  "held_attempt.reservation_id IN",a,b,
  "old_outbound.id=c.delivery_attention_message_id",
  "current_gate.state='unknown'",
  "customer.source_created_at>old_outbound.created_at",
  "customer.whatsapp_message_id IS NOT NULL",
  "sender_conversations", // checked below as sender_conversations substring
  "new_context", // checked instead as message context alias below
 ]) {
  // Keep source and SQL assertions intentionally narrow.
  if(proof==="sender_conversations" || proof==="new_context")continue;
  assert.ok(sql.includes(proof),proof);
 }
 assert.match(sql,/whatsapp_sender_conversations sc/);
 assert.match(sql,/whatsapp_sender_message_context mc/);
 assert.match(sql,/older\.reopened_at>NOW\(\)-INTERVAL '30 days'/);
 assert.match(sql,/ai_review_items review/);
 assert.match(sql,/takeover_by IS NULL/);
 assert.match(sql,/whatsapp_opt_out_at IS NULL/);
 assert.match(sql,/receipt\.pricing_billable=TRUE/);
 assert.doesNotMatch(sql,/SELECT .* FROM whatsapp_sender_unknown_hold_releases/);
});

test("Day4/Day6 candidate prefilter denies unreviewed, fresh and previously retried UNKNOWN holds",()=>{
 const denied=reviewedUnknownGateCandidateSql("c","sa",{});
 assert.match(denied,/held_attempt\.state='unknown'/);
 assert.match(denied,/AND FALSE/);
 const approved=reviewedUnknownGateCandidateSql("c","sa",env);
 assert.ok(approved.includes("held_attempt.reservation_id IN"));
 assert.ok(approved.includes(a));
 assert.ok(approved.includes(b));
 for(const required of [
  "preflight_gate.state='unknown'",
  "preflight_gate.updated_at<=NOW()-INTERVAL '30 minutes'",
  "previous.reopened_at>NOW()-INTERVAL '30 days'",
  "signed_failure.delivery_status='failed'",
  "signed_failure.matched=TRUE",
  "signed_failure.meta_phone_number_id=sa.meta_phone_number_id",
  "success.pricing_billable=TRUE",
  "failed_video.whatsapp_message_id=held_attempt.wamid",
 ])assert.ok(approved.includes(required),required);
 assert.throws(()=>reviewedUnknownGateCandidateSql("c;drop","sa",env));
});
