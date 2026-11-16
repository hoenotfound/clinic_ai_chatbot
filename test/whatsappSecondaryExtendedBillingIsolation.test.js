"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");

test("extended secondary follow-ups isolate unsettled reservations by customer", () => {
  for (const sql of [
    marketing.EXTENDED_CANDIDATES_SQL,
    marketing.EXTENDED_RECHECK_SQL,
    marketing.EXTENDED_POTENTIAL_DUE_SQL,
  ]) {
    assert.match(sql, /gate\.owner_contact_id=c\.id/);
    assert.match(sql, /gate\.state IN \('reserved','awaiting_pricing'\)/);
    assert.match(sql, /whatsapp_sender_billing_alarms alarm WHERE alarm\.sender_id=sa\.id/);
    assert.match(sql, /bad\.contact_id=c\.id/);
  }
});


test("Day4/Day6 pre-send checks exempt only the claimed message's own reservation", () => {
  const candidate = marketing.EXTENDED_CANDIDATES_SQL;
  const recheck = marketing.EXTENDED_RECHECK_SQL;
  // Discovery must not admit any active gate.
  assert.doesNotMatch(candidate,/own\\.message_id=gate\\.message_id/);
  // The final recheck must still reject another message's reservation.
  assert.match(recheck,/gate\\.state IN \\('reserved','awaiting_pricing'\\)/);
  assert.match(recheck,/AND NOT \\(gate\\.state='reserved' AND EXISTS \\(/);
  assert.match(recheck,/own\\.sender_id=sa\\.id AND own\\.contact_id=c\\.id/);
  assert.match(recheck,/own\\.anchor_message_id=qualified_session\\.origin_id/);
  assert.match(recheck,/own\\.slot_hours=rule\\.slot_hours AND own\\.status='claimed'/);
  assert.match(recheck,/own\\.message_id IS NOT NULL AND own\\.message_id=gate\\.message_id/);
  // A different contact, message or awaiting-pricing gate remains excluded.
  assert.match(recheck,/gate\\.owner_contact_id=c\\.id/);
  assert.match(recheck,/gate\\.state='reserved'/);
});

test("proven pre-Meta marketing cancellations cannot be replayed or marked delivered",async()=>{
 const finish=marketing.finishProvenMarketingPreProviderCancellation;
 let calls=0;
 const database={query:async(sql,args)=>{
  calls++;
  assert.match(sql,/bill\\.state='rejected' AND bill\\.wamid IS NULL/);
  assert.match(sql,/m\\.whatsapp_message_id IS NULL AND m\\.whatsapp_accepted_at IS NULL/);
  assert.match(sql,/whatsapp_sender_status_receipts receipt/);
  assert.match(sql,/outbound_message_evidence outbound/);
  assert.match(sql,/FOR UPDATE OF a,m/);
  assert.match(sql,/SET delivery_status='cancelled'/);
  assert.match(sql,/SET status='blocked',error_code='secondary_pre_provider_cancelled'/);
  assert.deepEqual(args,[66,20190,9033]);
  return {rows:[{id:66}]};
 }};
 const base={database,attemptId:66,messageId:20190,contactId:9033,
   result:{success:false,wamid:null,preProviderCancelled:true}};
 assert.equal(await finish(base),true);
 assert.equal(calls,1);
 for(const result of [
   {...base.result,unknown:true},{...base.result,ambiguous:true},
   {...base.result,wamid:"wamid.possibly-sent"},
   {...base.result,preProviderCancelled:false},
 ])assert.equal(await finish({...base,result}),false);
 assert.equal(calls,1);
});
