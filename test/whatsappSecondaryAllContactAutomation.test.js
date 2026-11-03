"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  adsOnlyActivation,originalAdsOnlyCutoff,
  secondaryAutomationActivation,secondaryAutomationEligibleSql,
  isSecondaryAutomationEligible,
}=require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const service=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const media=require("../src/services/whatsappSecondaryAiMediaQueue");
const {secondaryAdsOnlyFullAiMode}=require("../src/services/whatsappSenderActivationGate");

const env={
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
  WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
  WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-03T04:00:23Z",
  WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-03T04:15:00Z",
};
test("secondary all-contact automation requires independent post-reply cutover and keeps old ad source",()=>{
  assert.equal(adsOnlyActivation(env),null);
  assert.equal(originalAdsOnlyCutoff(env),"2026-10-30T03:00:00.000Z");
  assert.equal(secondaryAutomationActivation(env),"2026-11-03T04:15:00.000Z");
  for(const updates of [
    {WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-03T04:00:22Z"},
    {WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"bad"},
    {WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:""},
    {WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"ads_only"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"},
    {WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"off"},
  ])assert.equal(secondaryAutomationActivation({...env,...updates}),null,
    JSON.stringify(updates));
  const ads={...env,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only"};
  assert.equal(secondaryAutomationActivation(ads),"2026-10-30T03:00:00.000Z");
});

test("shared sender SQL requires post-cutover provider evidence for direct leads, and preserves original ad path",()=>{
  const sql=secondaryAutomationEligibleSql("c","$6","inbound","$7","$8");
  for(const clause of [
    "$7::text='ads_only'","$7::text='all_contacts'",
    "ads_sa.sender_key='neutro_secondary'",
    "verified_sa.sender_key='neutro_secondary'",
    "verified_sc.state='bound'","verified_context.message_id=inbound.id",
    "inbound.source_created_at >= $6::timestamptz",
    "inbound.created_at >= $6::timestamptz",
    "inbound.whatsapp_message_id IS NOT NULL",
    "old_sync.message_id=inbound.id","ads_first.created_at >= $8::timestamptz",
  ])assert.ok(sql.includes(clause),clause);
  for(const candidate of [service.CANDIDATES_SQL,service.RECHECK_SQL,
    marketing.CANDIDATES_SQL,marketing.RECHECK_SQL,
    media.READY_SQL,media.STILL_VALID_SQL]){
    assert.ok(candidate.includes("secondary") || candidate.includes("ads_sa.sender_key"),
      "sender must remain bound");
    assert.match(candidate,/verified_context.message_id=inbound.id/);
    assert.match(candidate,/old_sync.message_id=inbound.id/);
  }
  assert.match(service.POTENTIAL_DUE_SQL,/verified_context.message_id=inbound.id/);
  assert.match(marketing.POTENTIAL_DUE_SQL,/verified_context.message_id=inbound.id/);
  assert.match(marketing.CANDIDATES_SQL,/whatsapp_marketing_consent_events consent/);
  assert.match(marketing.CANDIDATES_SQL,/lead.marketing_consent='opted_in'/);
  assert.match(service.CANDIDATES_SQL,/lead.marketing_consent='opted_in'/);
  assert.match(media.READY_SQL,/c.whatsapp_opt_out_at IS NULL/);
});

test("secondary final send eligibility fails closed unless its inbound anchor is valid",async()=>{
  let called=0;
  const database={query:async(sql,params)=>{
    called++;
    assert.match(sql,/WHERE c.id=\$1 AND c.mode='ai'/);
    assert.deepEqual(params,[71,121,"2026-11-03T04:15:00.000Z",
      "all_contacts","2026-10-30T03:00:00.000Z"]);
    return {rows:[{eligible:true}]};
  }};
  assert.equal(await isSecondaryAutomationEligible(71,{
    database,env,inboundMessageId:121}),true);
  assert.equal(called,1);
  assert.equal(await isSecondaryAutomationEligible(71,{database,env}),false);
  assert.equal(await isSecondaryAutomationEligible(71,{
    database,env,inboundMessageId:"invalid"}),false);
  assert.equal(await isSecondaryAutomationEligible(71,{
    database,env:{...env,WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"old"},
    inboundMessageId:121}),false);
  assert.equal(called,1);
});

test("existing no-staff-send full AI mode remains allowed with correct all-contact cutover",()=>{
  const complete={...env,
    WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false",
    WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
    WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
    WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"false",
    WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"false",
    WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
  };
  assert.equal(secondaryAdsOnlyFullAiMode(complete),true);
  assert.equal(secondaryAdsOnlyFullAiMode({...complete,
    WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-03T03:59:00Z"}),false);
});
