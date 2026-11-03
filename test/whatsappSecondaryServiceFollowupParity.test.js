"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const svc=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");
const env={
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
 WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
 WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-03T04:00:23Z",
 WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-03T04:15:00Z",
 WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_SERVICE_FOLLOWUP_PARITY_ACTIVATED_AT:"2026-11-03T05:00:00Z",
};
test("Neutro secondary 24h parity requires a valid independent activation",()=>{
 assert.equal(svc.serviceFollowupParityActivation(env),
   "2026-11-03T05:00:00.000Z");
 for(const overrides of [
   {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
   {WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only"},
   {WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:""},
   {WHATSAPP_SECONDARY_SERVICE_FOLLOWUP_PARITY_ACTIVATED_AT:""},
   {WHATSAPP_SECONDARY_SERVICE_FOLLOWUP_PARITY_ACTIVATED_AT:"bad"},
   {WHATSAPP_SECONDARY_SERVICE_FOLLOWUP_PARITY_ACTIVATED_AT:"2026-11-03T04:14:59Z"},
 ])assert.equal(svc.serviceFollowupParityActivation({...env,...overrides}),null,
   JSON.stringify(overrides));
});

test("in-window service reminders allow fresh initiated chats, but do not loosen opted-out or marketing templates",()=>{
 assert.match(svc.CANDIDATES_SQL,
   /inbound\.source_created_at >= \$9::timestamptz/);
 assert.match(svc.RECHECK_SQL,
   /inbound\.source_created_at >= \$11::timestamptz/);
 assert.match(svc.CANDIDATES_SQL,
   /COALESCE\(lead\.marketing_consent,'unknown'\)<>'opted_out'/);
 assert.match(svc.RECHECK_SQL,
   /COALESCE\(latest_lead\.marketing_consent,'unknown'\)<>'opted_out'/);
 for(const sql of [svc.CANDIDATES_SQL,svc.RECHECK_SQL]){
   assert.match(sql,/c\.whatsapp_opt_out_at IS NULL/);
   assert.match(sql,/c\.whatsapp_marketing_opt_out_at IS NULL/);
   assert.match(sql,/pending_accepted|booking_hold|booking_lead/);
   assert.match(sql,/needs_attention=FALSE/);
   assert.match(sql,/INTERVAL '8 hours'/);
   assert.match(sql,/reviewed/);
 }
 assert.match(svc.CANDIDATES_SQL,
   /lead\.marketing_consent='opted_in'/);
 assert.match(svc.RECHECK_SQL,
   /latest_lead\.marketing_consent='opted_in'/);
 assert.match(marketing.CANDIDATES_SQL,
   /whatsapp_marketing_consent_events consent/);
 assert.match(marketing.CANDIDATES_SQL,
   /consent\.consent_scope='treatment_followups_and_related_offers'/);
 assert.doesNotMatch(marketing.CANDIDATES_SQL,/SERVICE_FOLLOWUP_PARITY/);
 assert.match(svc.POTENTIAL_DUE_SQL,/\$8::timestamptz/);
 assert.doesNotMatch(svc.POTENTIAL_DUE_SQL,/\$9\b/);
});

test("read-only candidate and pre-send SQL both bind new parity time separately",async()=>{
 const calls=[];
 const database={query:async(sql,args)=>{
   calls.push({sql,args});
   if(sql===svc.CANDIDATES_SQL)return{rows:[]};
   if(sql===svc.POTENTIAL_DUE_SQL)return{rows:[{next_due_at:null,has_overdue:false}]};
   return{rows:[]};
 }};
 const e={...env,
   WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
   WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
   WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
   WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000001",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000001",
 };
 const result=await svc.runOnce({database,env:e});
 assert.equal(result.accepted,0);
 assert.equal(calls[0].args.length,9);
 assert.equal(calls[0].args[8],"2026-11-03T05:00:00.000Z");
 const hint=await svc.nextPotentialDueAt({database,env:e});
 assert.equal(hint.next_due_at,null);
 assert.equal(calls[1].args.length,8);
 assert.equal(calls[1].args[7],"2026-11-03T05:00:00.000Z");
});
