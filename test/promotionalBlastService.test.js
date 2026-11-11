"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const blast=require("../src/services/promotionalBlastService");

test("blast candidate query requires verified sender-linked CTWA pricing, consent and one-hour expiry buffer",()=>{
  const sql=blast.CANDIDATE_SQL;
  for(const fragment of [
    "whatsapp_free_entry_referrals",
    "whatsapp_free_entry_pricing_evidence",
    "whatsapp_sender_status_receipts",
    "whatsapp_sender_message_context",
    "consent_scope='treatment_followups_and_related_offers'",
    "reply.created_at+interval '167 hours'",
    "whatsapp_marketing_opt_out_at IS NULL",
    "stage.stage_type",
    "whatsapp_template->>'name'",
    "secondary_billing_unresolved",
    "overlapping repeat ad click",
  ]) assert.ok(sql.includes(fragment),fragment);
});

test("invalid recipient, language or staff never creates a claim",async()=>{
  const database={query:()=>{throw new Error("Unexpected SQL");}};
  assert.equal(await blast.claimRecipient(-1,"zh_CN","admin",database),null);
  assert.equal(await blast.claimRecipient(8,"fr","admin",database),null);
  assert.equal(await blast.claimRecipient(8,"zh_CN","",database),null);
  assert.equal(await blast.consumeClaim(8,"wrong","zh_CN","admin",database),false);
  assert.equal(await blast.consumeClaim(8,blast.CAMPAIGN_KEY,"fr","admin",database),false);
});

test("preview records are read only and include prior claims",async()=>{
  const database={
    async query(sql,params){
      assert.match(sql,/SELECT qualified\.\*/);
      assert.match(sql,/already_claimed/);
      assert.deepEqual(params,[blast.CAMPAIGN_KEY]);
      return {rows:[{contact_id:42,already_claimed:true}]};
    },
  };
  assert.equal((await blast.candidates(database))[0].already_claimed,true);
});

test("claim is one-shot and cannot be created twice",async()=>{
  let queries=0;
  const database={
    async query(sql,params){
      queries++;
      assert.match(sql,/ON CONFLICT DO NOTHING/);
      assert.match(sql,/blocked_reason IS NULL/);
      assert.deepEqual(params,[blast.CAMPAIGN_KEY,42,"zh_CN","admin"]);
      return {rows:queries===1?[{id:1,contact_id:42}]:[]};
    }
  };
  assert.equal((await blast.claimRecipient(42,"zh_CN","admin",database)).contact_id,42);
  assert.equal(await blast.claimRecipient(42,"zh_CN","admin",database),null);
});

test("consume atomically changes only a reserved claim and never retries",async()=>{
  let invoked=0;
  const database={
    async query(sql,params){
      invoked++;
      assert.match(sql,/SET state='attempted'/);
      assert.match(sql,/claim\.state='reserved'/);
      assert.match(sql,/qualified\.blocked_reason IS NULL/);
      assert.deepEqual(params,[blast.CAMPAIGN_KEY,42,"admin","ms"]);
      return {rows:invoked===1?[{id:1}]:[]};
    }
  };
  assert.equal(await blast.consumeClaim(42,blast.CAMPAIGN_KEY,"ms","admin",database),true);
  assert.equal(await blast.consumeClaim(42,blast.CAMPAIGN_KEY,"ms","admin",database),false);
});
