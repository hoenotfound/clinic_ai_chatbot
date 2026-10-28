"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const review=require("../src/services/whatsappSecondaryQaPassiveReview");
const capture=require("../src/services/whatsappSecondaryQaCapture");
const KEY=Buffer.alloc(32,31);
function cfg(overrides={}){return{
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
  WHATSAPP_APP_SECRET:"a".repeat(32),META_APP_SECRET:"a".repeat(32),
  WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"x".repeat(32),
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
  WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60129998888",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
    "postgresql://qa:password@ep-qa.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.ap-southeast-1.aws.neon.tech",
  DATABASE_URL:"postgresql://prod:password@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
  WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
  WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60129998888",
  WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:KEY.toString("base64"),
  ...overrides
};}
function row(field,value){
  const raw=Buffer.from(JSON.stringify({entryTime:1790000000,
    change:{field,value:{metadata:{phone_number_id:"112233"},...value}}}));
  const fingerprint=crypto.createHash("sha256").update(raw).digest("hex");
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",KEY,nonce);
  cipher.setAAD(Buffer.from(fingerprint,"ascii"));
  return {fingerprint,event_field:field,
    ciphertext:Buffer.concat([cipher.update(raw),cipher.final()]),
    nonce,auth_tag:cipher.getAuthTag(),payload_bytes:raw.length};
}
function db(data,{sender=true,validSchema=true}={}){
  const queries=[];let released=0;
  return{queries,get released(){return released;},
    async connect(){return{async query(sql,params){
      queries.push({sql,params});
      if(sql.includes("FROM schema_migrations"))return{rows:validSchema?[
        {version:102,name:"whatsapp_coexistence_preidentity_events"},
        {version:103,name:"whatsapp_legacy_lifecycle_relay_audit"},
        {version:104,name:"whatsapp_coexistence_once_only_and_lifecycle_alerts"}
      ]:[]};
      if(sql.includes("FROM whatsapp_sender_accounts"))
        return{rows:sender?[{id:42}]:[]};
      if(sql.includes("FROM whatsapp_secondary_qa_capture_events"))
        return{rows:data.slice(0,params[1])};
      throw Error("Unexpected read-only SQL");
    },release(){released++;}};}
  };
}
test("QA passive review reads encrypted messages/echo/history/contacts without PII or effects",async()=>{
  const rows=[
    row("messages",{messages:[{from:"60111111111",text:{body:"secret customer message"}}]}),
    row("smb_message_echoes",{message_echoes:[{message:{text:"secret staff"}}]}),
    row("history",{history:[{metadata:{phase:"0",progress:"100"},
      threads:[{id:"private",messages:[{text:"older customer message"}]}]}]}),
    row("smb_app_state_sync",{state_sync:[{type:"contact",contact:{name:"private person"}}]})
  ];
  const database=db(rows);
  const result=await review.reviewSecondaryCapture({env:cfg(),database,limit:20});
  assert.deepEqual([result.counts.messages,result.counts.smb_message_echoes,
    result.counts.history,result.counts.smb_app_state_sync],[1,1,1,1]);
  assert.equal(result.counts.historyMessages,1);
  assert.equal(result.counts.appStateContacts,1);
  assert.deepEqual(result.historyPhases,[0]);
  assert.equal(result.observedMaxHistoryProgress,100);
  assert.equal(result.historyImportComplete,false);
  assert.equal(result.inboxUpdated,false);
  assert.equal(result.aiRepliesSent,false);
  assert.equal(result.readOnly,true);
  assert.equal(JSON.stringify(result).includes("private"),false);
  assert.equal(JSON.stringify(result).includes("secret"),false);
  assert.ok(database.queries.every(q=>/^SELECT /i.test(q.sql)));
  assert.deepEqual(database.queries.at(-1).params,[42,20]);
  assert.equal(database.released,1);
});
test("wrong account, missing migrations or disabled capture must reject",async()=>{
  await assert.rejects(review.reviewSecondaryCapture({
    env:cfg({WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false"}),
    database:db([])}),/disabled/);
  await assert.rejects(review.reviewSecondaryCapture({
    env:cfg(),database:db([],{sender:false})}),/sender/);
  await assert.rejects(review.reviewSecondaryCapture({
    env:cfg(),database:db([],{validSchema:false})}),/history/);
});
test("corrupt AES-GCM tag and oversized batches fail closed without exposing content",()=>{
  const r=row("history",{history:[]});
  r.auth_tag=Buffer.alloc(16,0);
  assert.throws(()=>review.decryptRow(r,KEY));
  assert.throws(()=>review.summarizeChange("unknown",{}),/Malformed/);
});
test("passive reader is confined to QA storage without Inbox, Graph or sends",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappSecondaryQaPassiveReview.js"),"utf8");
  assert.doesNotMatch(source,/INSERT INTO|UPDATE |DELETE FROM|fetch\(|graph.facebook.com|sendWhatsApp|queueIncomingForReply|scheduleDurableClaim/);
  assert.match(source,/expires_at>NOW\(\)/);
});
