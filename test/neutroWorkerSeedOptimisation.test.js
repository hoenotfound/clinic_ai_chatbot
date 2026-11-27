"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const general=require("../src/services/neutroSecondaryGeneralMarketingSql");

test("secondary marketing seeds use the same current sender and consent restrictions as final eligibility",()=>{
  for(const sql of [marketing.CANDIDATES_SQL,marketing.EXTENDED_CANDIDATES_SQL,
    marketing.RECHECK_SQL,marketing.EXTENDED_RECHECK_SQL,marketing.POTENTIAL_DUE_SQL,
    marketing.EXTENDED_POTENTIAL_DUE_SQL,general.CANDIDATES_SQL,general.RECHECK_SQL,general.POTENTIAL_DUE_SQL]){
    assert.match(sql,/seed_sender\.sender_key=\$1/);
    assert.match(sql,/seed_sender\.meta_phone_number_id=\$2/);
    assert.match(sql,/seed_sender\.meta_account_id=\$3/);
    assert.match(sql,/seed_contact\.mode='ai'/);
    assert.match(sql,/seed_contact\.takeover_by IS NULL/);
    assert.match(sql,/seed_contact\.whatsapp_marketing_opt_out_at IS NULL/);
    assert.match(sql,/seed_contact\.whatsapp_opt_out_at IS NULL/);
    assert.match(sql,/c\.whatsapp_sender_id=sa\.id/);
    assert.match(sql,/lead\.marketing_consent='opted_in'/);
  }
  assert.match(marketing.EXTENDED_CANDIDATES_SQL,/FROM whatsapp_free_entry_referrals seed_referral/);
  assert.match(general.POTENTIAL_DUE_SQL,/e\.consented_at=seed_contact\.whatsapp_opt_in_at/);
});
