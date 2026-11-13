"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const repo=require("../src/db/standalonePricingReminderRepo");
const feature=require("../src/services/standalonePricingReminderService");
const activate="2026-11-12T12:00:00.000Z";
const base={
 businessName:"Neutro Sense TCM Centre",
 automatedFollowUp:{enabled:true,assessmentFirstPricingEnabled:true,
   quietHours:{enabled:true,start:"00:00",end:"07:00"}}
};
function flags(extra={}){
 return {NEUTRO_STANDALONE_PRICING_REMINDER_ENABLED:"true",
 NEUTRO_STANDALONE_PRICING_REMINDER_ACTIVATED_AT:activate,
 NEUTRO_STANDALONE_PRICING_PRIMARY_ENABLED:"true",
 NEUTRO_STANDALONE_PRICING_SECONDARY_ENABLED:"true",...extra};
}
test("pricing is enabled for customer-initiated in-window enquiries, Neutro-only and sender-scoped",()=>{
 assert.equal(feature.settings({},base),null);
 assert.equal(feature.settings(flags({NEUTRO_STANDALONE_PRICING_REMINDER_ENABLED:"false"}),base),null);
 assert.equal(feature.settings(flags(),{...base,businessName:"Other Clinic"}),null);
 assert.equal(feature.settings(flags(),{...base,automatedFollowUp:{...base.automatedFollowUp,pricingReminder:{enabled:true}}}),null);
 const active=feature.settings(flags(),base);
 assert.deepEqual(active.senderKeys,["neutro","neutro_secondary"]);
 assert.equal(active.requirePricingInterest,false);
 assert.equal(base.automatedFollowUp.assessmentFirstPricingEnabled,true);
 assert.equal(feature.settings(flags({NEUTRO_STANDALONE_PRICING_SECONDARY_ENABLED:"false"}),base).senderKeys.length,1);
 assert.equal(feature.settings(flags({NEUTRO_STANDALONE_PRICING_PRIMARY_ENABLED:"false"}),base).senderKeys[0],"neutro_secondary");
 assert.equal(feature.settings(flags({NEUTRO_STANDALONE_PRICING_PRIMARY_ENABLED:"false",NEUTRO_STANDALONE_PRICING_SECONDARY_ENABLED:"false"}),base),null);
});
test("independent due time is 22 hours after customer and before 24-hour expiry",()=>{
 const source="2026-11-12T02:00:00.000Z"; // 10am MYT
 const candidate={source_at:source};
 assert.equal(feature.dueAt(candidate).toISOString(),"2026-11-13T00:00:00.000Z");
 assert.equal(feature.beforeEnd(candidate,new Date("2026-11-13T01:29:59Z")),true);
 assert.equal(feature.beforeEnd(candidate,new Date("2026-11-13T01:30:00Z")),false);
});
test("pricing waits 45 minutes after any accepted consent or service message",()=>{
 const c={source_at:"2026-11-12T02:00:00.000Z",
   last_automation_at:"2026-11-13T00:10:00.000Z"};
 assert.equal(feature.dueAt(c).toISOString(),"2026-11-13T00:55:00.000Z");
});
test("quiet-hour pricing never jumps to only 17h after a morning enquiry",()=>{
 const candidate={source_at:"2026-11-11T22:00:00.000Z"}; // 06:00 MYT
 assert.equal(feature.dueAt(candidate),null);
});
test("when at least 20 hours have elapsed, earlier evening is allowed",()=>{
 const candidate={source_at:"2026-11-11T18:00:00.000Z"}; // 02:00 MYT
 assert.equal(feature.dueAt(candidate).toISOString(),"2026-11-12T15:20:00.000Z"); // 23:20 MYT
});
test("disabled quiet hours keep the 22h due time",()=>{
 const candidate={source_at:"2026-11-11T22:00:00.000Z"};
 assert.equal(feature.dueAt(candidate,{enabled:false,start:"00:00",end:"07:00"}).toISOString(),
   "2026-11-12T20:00:00.000Z");
});
test("clinical questions and generic messages cannot trigger a price offer",()=>{
 const opts={requirePricingInterest:false,sendBothPelvicPackages:true};
 assert.deepEqual(feature.select({recent_customer_messages:["Hello"]},opts).offers,[]);
 const clinical=feature.select({recent_customer_messages:["I just had surgery. Can I do 3D?"]},opts);
 assert.deepEqual(clinical.offers,[]);
 assert.equal(feature.select({recent_customer_messages:["骨盆调理","不要了"]},opts).reason,
   "customer_declined");
});

test("vague follow-up uses only verified recent same-sender evidence, not old CRM guesses",()=>{
 const config={services:[
  {name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},
 ],serviceAliases:[
  {officialService:"骨盆调理",alias:"骨盆"},
  {officialService:"3D 小颜术",alias:"3D"},
  {officialService:"9D 逆龄抗衰",alias:"9D"},
 ]};
 const choose=(data,texts=["想了解更多"]) =>
   feature.resolveRecentPricingTreatment(data,texts,config);
 const lead={treatment_interest:"骨盆调理"};
 assert.equal(choose(lead).service,null,
   "historical CRM treatment alone is never permission for a new price");
 assert.equal(choose({...lead,recent_verified_treatment_consent:true}).service,"骨盆调理");
 assert.equal(choose({...lead,ad_treatment_interest:"骨盆调理"}).service,"骨盆调理",
   "SQL supplies only current sender-bound, recent provider-authenticated referrals");
 assert.equal(choose({...lead,ad_name:"骨盆调理体验"}).service,"骨盆调理");
 assert.equal(choose({...lead,ad_treatment_interest:"9D 逆龄抗衰"}).service,"9d 逆龄抗衰",
   "the latest verified ad can override a stale CRM treatment");
 assert.equal(choose({...lead,ad_name:"骨盆调理",ad_treatment_interest:"9D 逆龄抗衰"}).service,null);
 assert.equal(choose({...lead,recent_verified_treatment_consent:true},
   ["3D or 9D?"]).service,null,"comparison is not a treatment choice");
 assert.equal(choose({...lead,recent_verified_treatment_consent:true},
   ["3D"]).service,"3d 小颜术","latest stated interest overrides stale CRM interest");
 assert.equal(choose({...lead,recent_verified_treatment_consent:true},
   ["骨盆调理"]).service,"骨盆调理");
 const ambiguous=feature.select({...lead,recent_customer_messages:["你好"]},
   {requirePricingInterest:false,sendBothPelvicPackages:true});
 assert.deepEqual(ambiguous.offers,[],"no ad or consent proof means no promotion");
});

test("query is independent of third follow-up, sender-bound and uses fresh inbound evidence",()=>{
 const sql=repo.ELIGIBLE_SQL;
 assert.doesNotMatch(sql,/automated_follow_up_step\s*=\s*3/i);
 assert.match(sql,/sa\.sender_key=ANY\(\$1::text\[\]\)/);
 assert.match(sql,/inbound\.whatsapp_message_id LIKE 'wamid\.%'/);
 assert.match(sql,/inbound\.source_created_at IS NOT NULL/);
 assert.match(sql,/whatsapp_sender_message_context/);
 assert.match(sql,/whatsapp_sender_coexistence_history_messages/);
 assert.match(sql,/c\.takeover_by IS NULL/);
 assert.match(sql,/pricing_reminder_anchor_id=inbound\.id/);
 assert.match(sql,/has_accepted_package_a/);
 assert.match(sql,/next_preflight_retry_at/);
 assert.match(sql,/whatsapp_sender_billing_attempts/);
 assert.match(sql,/pricing_reminder_preflight_retries/);
 assert.match(sql,/quote\.content.*RM\[/s);
 assert.match(sql,/whatsapp_marketing_opt_out_at IS NULL/);
 assert.match(sql,/whatsapp_marketing_consent_events/);
 assert.match(sql,/consent_scope='treatment_followups_and_related_offers'/);
 assert.doesNotMatch(sql,/consent_lead.marketing_consent='opted_in'/);
 assert.match(sql,/COALESCE\(lead.marketing_consent,'unknown'\) <> 'opted_out'/);
 assert.doesNotMatch(sql,/VERIFIED_PRICING_CONSENT_SQL/);
 assert.match(sql,/proof_sender.sender_id=sa.id/);
 assert.match(sql,/proof.whatsapp_message_id=permission.provider_message_id/);
 assert.match(sql,/lead.treatment_interest/);
 assert.match(repo.stillEligible.toString(),/offer\?\.serviceName\|\|""/);
 assert.match(repo.stillEligible.toString(),/outbound\.automated_follow_up_target_service/);
 assert.match(sql,/lead\.id AS lead_id/);
 assert.match(repo.stillEligible.toString(),/candidate\.lead_id\?\?null/);
 assert.match(repo.stillEligible.toString(),/candidate\.treatment_interest\?\?null/);
 assert.match(repo.stillEligible.toString(),/JSON\.stringify\(candidate\.recent_customer_messages\|\|\[\]\)/);
 assert.match(sql,/appointment_set/);
});

test("customer-initiated follow-up does not require recorded marketing consent",()=>{
 const src=repo.ELIGIBLE_SQL;
 assert.match(src,/inbound\.whatsapp_message_id LIKE 'wamid\.%'/);
 assert.match(src,/inbound\.source_at > NOW\(\)-INTERVAL '23 hours 45 minutes'/);
 assert.match(src,/c\.whatsapp_opt_out_at IS NULL AND c\.whatsapp_marketing_opt_out_at IS NULL/);
 assert.doesNotMatch(src,/AND \$\{VERIFIED_PRICING_CONSENT_SQL\}/);
 assert.match(repo.stillEligible.toString(),/opted_out_lead/);
 assert.match(src,/FROM messages reply/);
 assert.match(src,/e.origin='system_fallback'/);
});

test("Package B is gated behind a verified A, and prevents resending uncertain results",()=>{
 const dbFunctions=[repo.claimAdditional.toString(),repo.stillEligible.toString(),repo.deferUnsent.toString(),
   repo.resumeDeferred.toString()].join("\n");
 assert.match(dbFunctions,/previous\.pricing_reminder_package_key='Package A'/);
 assert.match(dbFunctions,/gate\.state='idle'/);
 assert.match(dbFunctions,/media\.delivery_status IS DISTINCT FROM 'cancelled'/);
 assert.match(dbFunctions,/attempt\.state<>'rejected'/);
 assert.match(dbFunctions,/retry\.attempts<3/);
 assert.match(dbFunctions,/pricing_reminder_anchor_id/);
});
test("standalone sender checks keep existing stages and never enable messenger",()=>{
 const src=require("node:fs").readFileSync(require("node:path").join(__dirname,
  "../src/services/standalonePricingReminderService.js"),"utf8");
 assert.match(src,/const MAX_SENDS_PER_WAKE=2/);
 assert.match(src,/contact\.channel!=="whatsapp"/);
 assert.match(src,/origin:"ai_media"/);
 assert.match(src,/purpose:"marketing"/);
 assert.match(src,/await repo\.resumeDeferred/);
 assert.match(src,/await repo\.claimAdditional/);
 assert.match(src,/repo\.recordDecision/);
 assert.match(src,/reviewUnknownSecondaryBillingHoldsOnce/);
 assert.match(src,/contactsRepo\.setDeliveryAttention/);
 assert.match(src,/do not retry/);
 assert.match(repo.listUnresolvedSecondaryBillingHolds.toString(),/g\.state='unknown'/);
 assert.match(repo.listUnresolvedSecondaryBillingHolds.toString(),/c\.needs_attention IS DISTINCT FROM TRUE/);
});
