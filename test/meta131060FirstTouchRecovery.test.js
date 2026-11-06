"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { recoverUnavailableFirstTouchAd } = require("../src/db/leadAttributionRepo");
const { createLeadAttributionService } = require("../src/services/leadAttributionService");

const ad = {
  channel:"whatsapp", source:"meta_ads", adId:"120246874060960540",
  sourceType:"ad", platform:"meta", adName:"骨盆调理",
};

test("a recovered ad must have trusted live SQL proof and writes atomically once",async()=>{
  const queries=[];
  let released=false;
  const client={
    async query(sql,args) {
      queries.push({sql,args});
      if (sql.startsWith("UPDATE lead_attributions")) return {
        rows:[{id:66,lead_id:55,first_message_id:17255,enrichment_status:"pending"}],
      };
      return {rows:[]};
    },
    release(){released=true;},
  };
  const got=await recoverUnavailableFirstTouchAd({
    leadId:55,inboundMessageId:17255,attribution:ad,
  },{connect:async()=>client});
  assert.equal(got.first_message_id,17255);
  assert.equal(released,true);
  assert.deepEqual(queries.map(x=>x.sql.trim().split(/\\s+/).slice(0,2).join(" ")),[
    "BEGIN","UPDATE lead_attributions","UPDATE leads",
    "INSERT INTO","COMMIT",
  ]);
  const update=queries[1];
  for(const fragment of [
    "la.source='whatsapp_unattributed'","l.source='whatsapp_unattributed'",
    "initial.id=l.started_message_id","initial.id=la.first_message_id",
    "verified.id=$2","verified.source_created_at>=initial.source_created_at",
    "INTERVAL '10 minutes'","initial_job.incoming_payload->>'unsupportedType'='unsupported'",
    `'[{"code":131060}]'::jsonb`,
    "verified_job.incoming_payload->'attribution'->>'adId'=$3",
    "verified_job.incoming_payload->'attribution'->>'sourceType'='ad'",
    "sa.sender_key='neutro_secondary'","sc.state='bound'",
    "NOT EXISTS (\n           SELECT 1 FROM messages between_messages",
  ])assert.ok(update.sql.includes(fragment),fragment);
  assert.deepEqual(update.args.slice(0,3),[55,17255,ad.adId]);
});
test("an ordinary ad click or invalid inbound cannot start recovery without verified purpose",async()=>{
  let connects=0;
  const db={connect:async()=>{connects++;throw Error("unexpected DB");}};
  for (const payload of [
    {leadId:1,inboundMessageId:2,attribution:{...ad,source:"whatsapp_unattributed"}},
    {leadId:1,inboundMessageId:2,attribution:{...ad,adId:null}},
    {leadId:1,inboundMessageId:2,attribution:{...ad,channel:"facebook"}},
    {leadId:1,inboundMessageId:0,attribution:ad},
  ])assert.equal(await recoverUnavailableFirstTouchAd(payload,db),null);
  assert.equal(connects,0);
});
test("no matching Meta 131060 pair means no lead update or alert",async()=>{
  const statements=[];
  const client={
    async query(sql){statements.push(sql);return {rows:[]};},
    release(){},
  };
  const result=await recoverUnavailableFirstTouchAd({
    leadId:12,inboundMessageId:22,attribution:ad,
  },{connect:async()=>client});
  assert.equal(result,null);
  assert.deepEqual(statements.map(s=>s.slice(0,6)),["BEGIN","UPDATE","COMMIT"]);
});
test("transaction rolls back after a failed proof or downstream lead update",async()=>{
  const statements=[];
  let released=false;
  const client={
    async query(sql) {
      statements.push(sql);
      if(sql.startsWith("UPDATE lead_attributions"))return {rows:[{
        id:7,first_message_id:22,enrichment_status:"pending",
      }]};
      if(sql.startsWith("UPDATE leads"))throw Error("failed update");
      return {rows:[]};
    },
    release(){released=true;},
  };
  await assert.rejects(recoverUnavailableFirstTouchAd({
    leadId:12,inboundMessageId:22,attribution:ad,
  },{connect:async()=>client}),/failed update/);
  assert.equal(statements.at(-1),"ROLLBACK");
  assert.equal(released,true);
});
test("attribution service publishes and enriches only on a true recovery",async()=>{
  const actions=[], events=[], enrichment=[];
  const service=createLeadAttributionService({
    async recoverUnavailableFirstTouchAd(args) {
      actions.push(args);
      return {id:99,enrichment_status:"pending"};
    },
  },{publish:(...a)=>events.push(a)},{
    queueAttributionEnrichment:(id)=>enrichment.push(id),
  });
  const incoming={channel:"whatsapp",text:"Hi, interested in pelvic care",attribution:ad};
  assert.equal((await service.recoverUnavailableFirstTouchAd({
    lead:{id:12},incoming,messageId:123,
  })).id,99);
  assert.equal(actions.length,1);
  assert.equal(events[0][0],"pipeline_changed");
  assert.deepEqual(enrichment,[99]);
  assert.equal(await service.recoverUnavailableFirstTouchAd({
    lead:{id:12}, incoming:{...incoming,text:""},messageId:124,
  }),null);
  assert.equal(actions.length,1);
});
test("inbound preparation tries recovery only for an existing ad lead",()=>{
  const src=fs.readFileSync(path.join(__dirname,
    "../src/services/inboundMessageClaimService.js"),"utf8");
  assert.match(src,/if \(startsThisJourney\)/);
  assert.match(src,/else \{[\s\S]*?attribution\.recoverUnavailableFirstTouchAd\?\.\(/);
  assert.match(src,/Failed to repair Meta 131060 first-touch/);
});
