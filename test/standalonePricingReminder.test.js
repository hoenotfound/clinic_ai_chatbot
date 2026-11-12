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
test("pricing is opt-in, Neutro-only, sender-scoped and preserves assessment-first",()=>{
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
test("quiet-hours target is brought forward to previous local evening",()=>{
 const candidate={source_at:"2026-11-11T22:00:00.000Z"}; // 06:00 MYT
 assert.equal(feature.dueAt(candidate).toISOString(),"2026-11-12T15:20:00.000Z");
});
test("clinical questions and generic messages cannot trigger a price offer",()=>{
 const opts={requirePricingInterest:false,sendBothPelvicPackages:true};
 assert.deepEqual(feature.select({recent_customer_messages:["Hello"]},opts).offers,[]);
 const clinical=feature.select({recent_customer_messages:["I just had surgery. Can I do 3D?"]},opts);
 assert.deepEqual(clinical.offers,[]);
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
 assert.match(sql,/prior\.pricing_reminder_anchor_id=inbound\.id/);
 assert.match(sql,/quote\.content.*RM\[/s);
 assert.match(sql,/whatsapp_marketing_opt_out_at IS NULL/);
 assert.match(sql,/appointment_set/);
});
