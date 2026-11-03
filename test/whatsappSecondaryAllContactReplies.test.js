"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  secondaryAllContactReplyActivation, isSecondaryAiReplyEligible,
  eligibleSecondaryAiReplyContactIds, adsOnlyActivation,
} = require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const followups = require("../src/services/whatsappSecondaryFollowUpService");
const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");
const media = require("../src/services/whatsappSecondaryAiMediaQueue");
const env={
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-03T03:20:00Z",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000012",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000012",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
};
test("all-contact replies have their own strict activation; ads-only followups remain unchanged",()=>{
  assert.equal(secondaryAllContactReplyActivation(env),"2026-11-03T03:20:00.000Z");
  assert.equal(adsOnlyActivation(env),"2026-10-30T03:00:00.000Z");
  for (const bad of [
    {...env,WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:""},
    {...env,WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-03"},
    {...env,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"},
    {...env,WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"},
    {...env,WHATSAPP_SECONDARY_SENDER_KEY:"not-neutro"},
  ])assert.equal(secondaryAllContactReplyActivation(bad),null);
  for(const sql of [followups.CANDIDATES_SQL,followups.RECHECK_SQL,
      marketing.CANDIDATES_SQL,media.READY_SQL,media.STILL_VALID_SQL]){
    assert.match(sql,/whatsapp_free_entry_referrals ads_ref/);
    assert.doesNotMatch(sql,/secondary_all_contact_reply/);
  }
});
test("provider-bound incoming proof and sender guards are required before generating an AI reply",async()=>{
  const calls=[];
  const db={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{eligible:true}]};}};
  const eligible=await isSecondaryAiReplyEligible(25,{
    database:db,env,inboundMessageId:400,
  });
  assert.equal(eligible,true);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].params,[
    25,"100000000000012","200000000000012","2026-11-03T03:20:00.000Z",400
  ]);
  for(const fragment of [
    "sa.sender_key='neutro_secondary'","sa.meta_phone_number_id=$2",
    "sa.meta_account_id=$3","sc.customer_wa_id=c.whatsapp_number",
    "sc.state='bound'","c.mode='ai'","c.needs_attention IS NOT TRUE",
    "c.whatsapp_opt_out_at IS NULL","inbound.id=$5",
    "inbound.whatsapp_message_id IS NOT NULL",
    "inbound.source_created_at >= $4::timestamptz",
    "inbound.created_at >= $4::timestamptz",
  ])assert.ok(calls[0].sql.includes(fragment),fragment);
  const noProof=await isSecondaryAiReplyEligible(25,{database:db,env});
  assert.equal(noProof,true);
  assert.doesNotMatch(calls[1].sql,/inbound.id=\$5/);
  for(const bad of [
    {WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"invalid"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"wrong"},
    {WHATSAPP_SECONDARY_WABA_ID:""},
  ])assert.equal(await isSecondaryAiReplyEligible(25,{
    database:db,env:{...env,...bad},inboundMessageId:400
  }),false);
  assert.equal(calls.length,2,"disabled audience never queries Neon");
});
test("all-contact Inbox eligibility is one batched query and fails closed",async()=>{
  let calls=0;
  const db={query:async(sql,p)=>{calls++;
    assert.match(sql,/c.mode='ai'/);
    assert.match(sql,/c.whatsapp_opt_out_at IS NULL/);
    assert.deepEqual(p,[[5,6],"100000000000012","200000000000012"]);
    return {rows:[{id:5},{id:6}]};
  }};
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([5,6,5,-1],{
    database:db,env})],[5,6]);
  assert.equal(calls,1);
  assert.deepEqual([...await eligibleSecondaryAiReplyContactIds([5],{
    database:db,env:{...env,WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"bad"}
  })],[]);
  assert.equal(calls,1);
  const broken={query:async()=>{throw Error("temporary DB failure")}};
  assert.equal((await eligibleSecondaryAiReplyContactIds([5],{
    database:broken,env})).size,0);
  assert.equal(await isSecondaryAiReplyEligible(5,{
    database:broken,env,inboundMessageId:200}),false);
});
