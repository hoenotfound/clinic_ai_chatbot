"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const whatsapp=require("../src/services/whatsappService");
const repo=require("../src/db/whatsappConsentPromptRepo");
const {
  consentQuestion,consentButtons,YES_TEXT,NO_TEXT,
}=require("../src/utils/whatsappConsentPrompt");

test("final consent prompt uses an explicit clinic and treatment with two distinct interactive buttons",()=>{
  assert.equal(consentQuestion({serviceName:"骨盆调理",businessName:"Neutro Sense TCM"}),
    "对了～之后如果有关于骨盆调理的资讯或相关优惠，Neutro Sense TCM 可以继续 WhatsApp 跟进通知您吗？😊");
  const buttons=consentButtons(37);
  assert.deepEqual(buttons,[
    {id:"da_consent_yes:37",title:YES_TEXT},
    {id:"da_consent_no:37",title:NO_TEXT},
  ]);
  assert.equal(repo.parseResponseId(buttons[0].id).decision,"accepted");
  assert.equal(repo.parseResponseId(buttons[1].id).decision,"declined");
  for (const invalid of [
    "da_consent_yes:0", "da_consent_yes:-1", "da_consent_yes:abc",
    "da_consent_yes:37x", "同意接收跟进优惠", "da_consent_yes:37 OR true",
  ]) assert.equal(repo.parseResponseId(invalid),null);
});

function inbound(type,message) {
  return {entry:[{changes:[{value:{
    contacts:[{wa_id:"60123456789",profile:{name:"Example"}}],
    messages:[{id:"wamid.customer.tap",from:"60123456789",type,...message}],
  }}]}]};
}
test("only actual WhatsApp interactive button replies gain a verified reply ID",()=>{
  const yes=whatsapp.parseIncomingMessages(inbound("interactive",{
    interactive:{type:"button_reply",
      button_reply:{id:"da_consent_yes:37",title:YES_TEXT}},
  }));
  assert.equal(yes.length,1);
  assert.equal(yes[0].interactiveReplyId,"da_consent_yes:37");
  assert.equal(yes[0].text,YES_TEXT);
  assert.equal(yes[0].unsupportedType,null);
  const typed=whatsapp.parseIncomingMessages(inbound("text",{text:{body:YES_TEXT}}));
  assert.equal(typed.length,1);
  assert.equal(Object.hasOwn(typed[0],"interactiveReplyId"),false);
  const fake=whatsapp.parseIncomingMessages(inbound("interactive",{
    interactive:{type:"list_reply",list_reply:{id:"da_consent_yes:37",title:YES_TEXT}},
  }));
  assert.equal(fake.length,1);
  assert.equal(fake[0].unsupportedType,"interactive");
});

function fakeDatabase({alreadyRecorded=false,stop=false,decline=false}={}) {
  const statements=[];
  const prompt={
    id:37,contact_id:7,lead_id:17,anchor_id:3,message_id:44,
    service_name:"骨盆调理",status:"accepted",
    created_at:"2026-10-12T04:00:00Z",response_message_id:alreadyRecorded?101:null,
    decision:alreadyRecorded?(decline?"declined":"accepted"):null,
    whatsapp_opt_out_at:stop?"2026-10-11T00:00:00Z":null,
    whatsapp_marketing_opt_out_at:null,whatsapp_opt_in_at:null,
    prompt_provider_id:"wamid.real.consent.question",prompt_accepted_at:"2026-10-12T04:05:00Z",
  };
  const msg={
    id:101,role:"user",content:decline?NO_TEXT:YES_TEXT,
    whatsapp_message_id:"wamid.real.tap",sent_at:"2026-10-12T04:30:00Z",
    media_mime_type:null,is_forwarded:false,
  };
  const db={connect:async()=>({
    query:async(sql,args)=>{
      statements.push(sql);
      if(sql.includes("FROM whatsapp_consent_prompts p JOIN contacts c"))return {rows:[prompt]};
      if(sql.includes("FROM messages WHERE id=$1 AND contact_id=$2"))return {rows:[msg]};
      if(sql.includes("INSERT INTO whatsapp_marketing_consent_events"))return {rowCount:1,rows:[{id:555}]};
      return {rows:[],rowCount:1};
    },
    release(){},
  })};
  return {db,statements};
}
test("genuine affirmative button writes the scoped audit and contact/lead consent in one transaction",async()=>{
  const {db,statements}=fakeDatabase();
  const result=await repo.recordButtonResponse({
    contactId:7,messageId:101,leadId:17,replyId:"da_consent_yes:37",
    businessName:"Neutro Sense TCM Centre",
  },{database:db});
  assert.deepEqual(result,{handled:true,decision:"accepted"});
  assert.ok(statements.some(s=>s.includes("INSERT INTO whatsapp_marketing_consent_events")));
  assert.ok(statements.some(s=>s.includes("whatsapp_opt_in_at=$2")));
  assert.ok(statements.some(s=>s.includes("marketing_consent='opted_in'")));
  assert.ok(statements.includes("COMMIT"));
});
test("decline and replay never grant fresh marketing consent",async()=>{
  const declined=fakeDatabase({decline:true});
  assert.equal((await repo.recordButtonResponse({
    contactId:7,messageId:101,leadId:17,replyId:"da_consent_no:37",businessName:"Neutro Sense TCM",
  },{database:declined.db})).decision,"declined");
  assert.equal(declined.statements.some(s=>s.includes("INSERT INTO whatsapp_marketing_consent_events")),false);
  const replay=fakeDatabase({alreadyRecorded:true});
  const result=await repo.recordButtonResponse({
    contactId:7,messageId:101,leadId:17,replyId:"da_consent_yes:37",businessName:"Neutro Sense TCM",
  },{database:replay.db});
  assert.equal(result.handled,true);
  assert.equal(result.alreadyRecorded,true);
  assert.equal(replay.statements.some(s=>s.includes("UPDATE contacts")),false);
});
test("global STOP blocks a button from reviving consent",async()=>{
  const {db,statements}=fakeDatabase({stop:true});
  const result=await repo.recordButtonResponse({
    contactId:7,messageId:101,leadId:17,replyId:"da_consent_yes:37",businessName:"Neutro Sense TCM",
  },{database:db});
  assert.equal(result.handled,false);
  assert.equal(statements.some(s=>s.includes("INSERT INTO whatsapp_marketing_consent_events")),false);
});
test("candidate and final pre-send SQL require FU3, current lead, 24h and no prior prompt",()=>{
  assert.match(repo.CANDIDATES_SQL,/automated_follow_up_step=3/);
  assert.match(repo.CANDIDATES_SQL,/third|final/);
  assert.match(repo.CANDIDATES_SQL,/23 hours 50 minutes/);
  assert.match(repo.CANDIDATES_SQL,/NOT EXISTS\(SELECT 1 FROM whatsapp_consent_prompts p/);
  assert.match(repo.CANDIDATES_SQL,/lead.marketing_consent='unknown'/);
  assert.match(repo.CANDIDATES_SQL,/whatsapp_marketing_consent_events evidence/);
  assert.match(repo.CANDIDATES_SQL,/pricing_reminder_decisions decision/);
  assert.match(repo.CANDIDATES_SQL,/GREATEST\(final.whatsapp_accepted_at/);
  assert.match(repo.CANDIDATES_SQL,/whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(repo.CANDIDATES_SQL,/whatsapp_opt_out_at IS NULL/);
});

test("a reply is not consent unless its stored prompt was accepted by Meta",async()=>{
  const sample=fakeDatabase();
  // Exercise the same provider-acceptance guard used for real webhook receipts.
  const original=sample.db.connect;
  sample.db.connect=async()=> {
    const client=await original();
    const query=client.query;
    client.query=async(sql,params)=>{
      const result=await query(sql,params);
      if(sql.includes("FROM whatsapp_consent_prompts p JOIN contacts c")){
        result.rows[0].prompt_provider_id=null;
      }
      return result;
    };
    return client;
  };
  const answer=await repo.recordButtonResponse({
    contactId:7,messageId:101,leadId:17,
    replyId:"da_consent_yes:37",businessName:"Neutro Sense TCM",
  },{database:sample.db});
  assert.equal(answer.handled,false);
  assert.ok(!sample.statements.some(x=>x.includes("INSERT INTO whatsapp_marketing_consent_events")));
});
