"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const blast=require("../src/services/promotionalBlastService");

test("read-only candidate SQL checks scoped sender, quiet hours, consent and dispatch deadline",()=>{
 const sql=blast.CANDIDATE_SQL;
 for(const match of [
  "whatsapp_free_entry_referrals","whatsapp_free_entry_pricing_evidence",
  "whatsapp_sender_status_receipts","whatsapp_sender_message_context",
  "consent_scope='treatment_followups_and_related_offers'",
  "reply.created_at+interval '167 hours'",
  "now()+interval '10 minutes'",
  "gate.owner_contact_id=c.id","gate.contact_id=c.id",
  "whatsapp_sender_billing_alarms",
  "whatsapp_marketing_opt_out_at IS NULL",
  "automatedFollowUp,quietHours",
  "Asia/Kuala_Lumpur","target_treatments",
  "related_offer_review_required",
  "campaign.valid_until",
 ])assert.ok(sql.includes(match),match);
 assert.equal(sql.includes("gate.sender_id=2 AND gate.state<>'idle'"),false);
});
test("dispatch SQL excludes only the staged current message",()=>{
 const sql=blast.DISPATCH_SQL;
 assert.match(sql,/outgoing\.id<>\$6::integer/);
 assert.match(sql,/staff\.id<>\$6::integer/);
 assert.match(sql,/sent_promo\.id<>\$6::integer/);
 assert.match(sql,/gate\.message_id IS DISTINCT FROM \$6::integer/);
 assert.match(blast.CANDIDATE_SQL,/gate\.contact_id=c\.id AND gate\.state<>'idle'/);
 for(const match of ["outgoing.created_at>now()-interval '5 hours'","staff.role='assistant'","sent_promo.whatsapp_template"])
  assert.ok(sql.includes(match),match);
});

test("invalid language, actor, token and message ID never query the database",async()=>{
 const database={query(){throw Error("SQL must not execute");}};
 for(const [id,lang,actor] of [[-1,"zh_CN","admin"],[8,"fr","admin"],[8,"zh_CN",""]]){
  assert.equal(await blast.claimRecipient(id,lang,actor,{database}),null);
 }
 assert.equal(await blast.consumeClaim(8,"wrong","zh_CN","admin","a".repeat(36),12,database),false);
 assert.equal(await blast.consumeClaim(8,blast.CAMPAIGN_KEY,"fr","admin","a".repeat(36),12,database),false);
 assert.equal(await blast.consumeClaim(8,blast.CAMPAIGN_KEY,"ms","admin","bad",12,database),false);
 assert.equal(await blast.consumeClaim(8,blast.CAMPAIGN_KEY,"ms","admin","a".repeat(36),0,database),false);
});

test("campaigns are immutable and creation validates allowed treatments/deadlines",async()=>{
 const database={query:async()=>({rows:[]})};
 const valid={
  campaignKey:"ns_december_2026",templateName:"ns_dec_3d_promo",
  title:"December 3D promotion",promotedTreatment:"3D 小颜术",
  targetTreatments:["3D 小颜术","9D 逆龄抗衰"],
  validUntil:new Date(Date.now()+2*86400000).toISOString()
 };
 assert.equal(await blast.createCampaign({...valid,targetTreatments:["9D 逆龄抗衰"]},"admin",database),null);
 assert.equal(await blast.createCampaign({...valid,validUntil:new Date(Date.now()-1000).toISOString()},"admin",database),null);
 assert.equal(await blast.createCampaign({...valid,campaignKey:"'; DROP TABLE--"},"admin",database),null);
 const createdSql=[];
 const fakeDB={async query(sql,values){
   createdSql.push(sql);
   assert.equal(values[0],"ns_december_2026");
   assert.deepEqual(values[4],["3D 小颜术","9D 逆龄抗衰"]);
   return {rows:[{campaign_key:values[0]}]};
 }};
 assert.equal((await blast.createCampaign(valid,"admin",fakeDB)).campaign_key,"ns_december_2026");
 assert.match(createdSql[0],/ON CONFLICT DO NOTHING/);
});

test("preview returns claims without sending",async()=>{
 const database={async query(sql,params){
   assert.match(sql,/SELECT qualified\.\*/);
   assert.match(sql,/claim\.state='attempted'/);
   assert.deepEqual(params,[blast.CAMPAIGN_KEY]);
   return {rows:[{contact_id:42,already_claimed:true}]};
 }};
 assert.equal((await blast.candidates(blast.CAMPAIGN_KEY,database))[0].already_claimed,true);
});

test("reservation has a one-time token and unused reservations may rotate after five minutes",async()=>{
 let times=0;
 const database={async query(sql,params){
   times++;
   assert.match(sql,/ON CONFLICT \(campaign_key,recipient_key\) DO UPDATE/);
   assert.match(sql,/whatsapp_promotional_blast_claims\.state='reserved'/);
   assert.match(sql,/whatsapp_promotional_blast_claims\.claimed_at<now\(\)-interval '5 minutes'/);
   assert.equal(params[0],blast.CAMPAIGN_KEY);
   assert.equal(params[1],42);
   assert.equal(params[2],"zh_CN");
   assert.equal(params[3],"admin");
   assert.match(params[4],/^[0-9a-f-]{36}$/i);
   assert.equal(params[5],true);
   return {rows:times===1?[{id:1,contact_id:42,reservation_token:params[4]}]:[]};
 }};
 const first=await blast.claimRecipient(42,"zh_CN","admin",{database,relatedOfferReviewed:true});
 assert.equal(first.contact_id,42);
 assert.equal(await blast.claimRecipient(42,"zh_CN","admin",{database,relatedOfferReviewed:true}),null);
});

test("final authorization is irreversible, checks recipient and staged row and never retries",async()=>{
 let calls=0;
 const token="11111111-1111-4111-8111-111111111111";
 const database={async query(sql,args){
   calls++;
   assert.match(sql,/SET state='attempted'/);
   assert.match(sql,/claim\.state='reserved'/);
   assert.match(sql,/claim\.reservation_token=\$5::uuid/);
   assert.match(sql,/qualified\.recipient_key=claim\.recipient_key/);
   assert.match(sql,/qualified\.related_offer_review_required/);
   assert.match(sql,/outgoing\.id<>\$6::integer/);
   assert.deepEqual(args,[blast.CAMPAIGN_KEY,42,"admin","ms",token,997]);
   return {rows:calls===1?[{id:1}]:[]};
 }};
 assert.equal(await blast.consumeClaim(42,blast.CAMPAIGN_KEY,"ms","admin",token,997,database),true);
 assert.equal(await blast.consumeClaim(42,blast.CAMPAIGN_KEY,"ms","admin",token,997,database),false);
});

test("failed staged blast messages are recoverable only while their claim was never attempted",()=>{
 const sql=blast.CANDIDATE_SQL;
 assert.match(sql,/recoverable_unsent AS \(/);
 assert.match(sql,/message\.whatsapp_template->>'blastCampaignKey'=promo\.campaign_key/);
 assert.match(sql,/message\.delivery_status='failed'/);
 assert.match(sql,/message\.whatsapp_message_id IS NULL/);
 assert.match(sql,/claim\.state='reserved'/);
 assert.match(sql,/claim\.attempted_at IS NULL/);
 assert.match(sql,/claim\.sender_id|recipient\.whatsapp_sender_id=claim\.sender_id/);
 assert.match(sql,/regexp_replace\(recipient\.whatsapp_number/);
 // All three filters previously treated a saved but unsent staff row as a
 // completed campaign. Every filter must exclude only proven unsent rows.
 for(const alias of ["outgoing","staff","sent_promo"]) {
   assert.ok(sql.includes(`unsent.id=${alias}.id`),alias);
 }
 assert.match(sql,/claim\.attempted_at IS NULL/);
 assert.doesNotMatch(sql,/message\.delivery_status IN \('failed','unknown'\)/);
 // Dispatch must continue to exclude exactly its OWN staged message in
 // addition to the proven unsent history rows.
 assert.match(blast.DISPATCH_SQL,/sent_promo\.id<>\$6::integer/);
 assert.match(blast.DISPATCH_SQL,/outgoing\.id<>\$6::integer/);
 assert.match(blast.DISPATCH_SQL,/staff\.id<>\$6::integer/);
});

test("blast recovery only marks staged rows as no-provider on each sender route",()=>{
 const fs=require("node:fs");
 const path=require("node:path");
 const source=fs.readFileSync(path.join(__dirname,"../src/routes/conversations.js"),"utf8");
 const secondary=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryTemplateService.js"),"utf8");
 const primary=fs.readFileSync(path.join(__dirname,"../src/services/whatsappTemplateService.js"),"utf8");
 // Both send paths must persist their server-chosen campaign key rather than
 // trusting the client or an unauthenticated message row.
 assert.equal((source.match(/blastCampaignKey:blastCampaignKeyForMessage/g)||[]).length,2);
 assert.match(source,/send\.providerNotAttempted===true/);
 assert.match(source,/sendResult\.providerNotAttempted===true/);
 assert.match(secondary,/providerNotAttempted:true/);
 assert.match(primary,/providerNotAttempted:true/);
 // Existing generic template retry remains blocked. The operator must create
 // a new, one-shot reviewed send after recovery.
 assert.match(source,/code: "template_retry_requires_billing_review"/);
});
