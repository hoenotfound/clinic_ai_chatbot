"use strict";
// Synthetic-only: no Meta API, Neutro database, live phone or outbound calls.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const capture=require("../src/services/whatsappSecondaryQaCapture");
const handoff=require("../src/services/whatsappSecondaryCaptureHandoff");
const history=require("../src/services/whatsappCoexistenceHistoryService");

function env(patch={}){
  return {
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
    WHATSAPP_APP_SECRET:"A".repeat(32),META_APP_SECRET:"A".repeat(32),
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"T".repeat(32),
    WHATSAPP_WABA_ID:"1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60174831336",
    WHATSAPP_PAID_REAL_CLINIC_REHEARSAL_ENABLED:"true",
    WHATSAPP_PAID_REAL_CLINIC_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_REAL_CLINIC_E164_PIN:"+60174831336",
    DATABASE_URL:"postgresql://target:synthetic@ep-target.neon.tech/qa_inbox",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://encrypted:synthetic@ep-encrypted.neon.tech/capture",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-encrypted.neon.tech",
    WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
    WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
    WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60174831336",
    WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:Buffer.alloc(32,29).toString("base64"),
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED:"true",
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED:"true",
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST:"ep-target.neon.tech",
    PR395_STAGING_MODE:"true",
    ...patch
  };
}
const timestamp=()=>String(Math.floor(Date.now()/1000)-7200);
function change(field="history",messages=[{
  id:"wamid.synthetic-customer",type:"text",timestamp:timestamp(),
  from:"60126662222",text:{body:"Historical hello"},
},{
  id:"wamid.synthetic-staff",type:"text",timestamp:timestamp(),
  from:"60174831336",to:"60126662222",text:{body:"Historical reply"},
}]){
  const value={metadata:{phone_number_id:"112233"}};
  if(field==="history")value.history=[{metadata:{phase:1,progress:50},
    threads:[{id:"60126662222",messages}]}];
  else if(field==="smb_app_state_sync")value.state_sync=[{
    type:"contact",action:"add",
    contact:{phone_number:"60126662222",full_name:"Synthetic Visitor"}
  }];
  else value.messages=[{id:"synthetic-live-message",text:{body:"ignore"}}];
  return {field,value};
}
function encrypted(field="history",messages){
  const e=env();
  const entryTime=1790000000;
  const body={object:"whatsapp_business_account",entry:[{
    id:"889900",time:entryTime,changes:[change(field,messages)]
  }]};
  const job=capture.classify(body,capture.captureConfig(e))[0];
  const encrypted=capture.encryptJob(job,Buffer.alloc(32,29));
  return {fingerprint:encrypted.fingerprint,sender_id:9,
    event_field:encrypted.field,ciphertext:encrypted.ciphertext,
    nonce:encrypted.nonce,auth_tag:encrypted.tag,payload_bytes:encrypted.bytes};
}
function sourceDb(initial,options={}){
  const rows=[...initial];let checkpointFail=!!options.checkpointFail;
  const queries=[];
  const source={queries,rows,async connect(){
    return {async query(sql,args=[]){
      queries.push({sql,args});
      if(sql.includes("FROM whatsapp_sender_accounts"))
        return {rows:[{id:9}]};
      if(sql.includes("FROM whatsapp_secondary_qa_capture_events"))
        return {rows:rows.filter(r=>!r.handoff_completed_at &&
          ["history","smb_app_state_sync"].includes(r.event_field)).slice(0,1)};
      if(sql.includes("SET handoff_completed_at")){
        if(checkpointFail){checkpointFail=false;throw Error("checkpoint interrupted");}
        const row=rows.find(r=>r.fingerprint===args[0]);
        if(!row||row.handoff_completed_at)return{rowCount:0};
        row.handoff_completed_at=true;return{rowCount:1};
      }
      return {rowCount:1,rows:[]};
    },release(){queries.push({release:true});}};
  }};
  return source;
}
function targetDb(){
  const jobs=new Map(), events=new Set(), messages=new Map();
  const calls=[];let nextId=100;
  const contact={id:44,whatsapp_sender_conversation_id:55};
  const q=async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return{rows:[{id:7}]};
    if(sql.includes("INSERT INTO whatsapp_sender_coexistence_import_jobs")){
      const [fp,id,field,payload]=args;
      if(jobs.has(fp))return{rowCount:0,rows:[]};
      jobs.set(fp,{fingerprint:fp,sender_id:id,event_field:field,
        payload:JSON.parse(payload),status:"pending",attempts:0});
      return {rowCount:1,rows:[{fingerprint:fp}]};
    }
    if(sql.includes("SELECT count(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs")){
      return {rows:[{n:args[0].filter(fp=>
        jobs.has(fp)&&["pending","processing","completed"].includes(jobs.get(fp).status)).length}]};
    }
    if(sql.startsWith("SELECT fingerprint FROM whatsapp_sender_coexistence_import_jobs"))
      return {rows:[...jobs.values()].filter(j=>j.status==="pending")
        .slice(0,args[1]).map(j=>({fingerprint:j.fingerprint}))};
    if(sql.includes("SET status='processing'")&&sql.includes("RETURNING payload,attempts")){
      const job=jobs.get(args[0]);
      if(!job||job.status!=="pending")return {rowCount:0,rows:[]};
      job.status="processing";job.attempts++;
      return {rowCount:1,rows:[{payload:job.payload,attempts:job.attempts}]};
    }
    if(sql.includes("SET status='completed',payload=NULL")){
      const job=jobs.get(args[0]);job.status="completed";job.payload=null;
      return{rowCount:1};
    }
    if(sql.includes("SET status=CASE WHEN attempts>=5")){
      const job=jobs.get(args[0]);job.status="pending";return{rows:[{status:"pending"}]};
    }
    if(sql.includes("SELECT outcome,messages_count"))
      return {rows:events.has(args[0])?[{outcome:"imported",messages_count:1}]:[]};
    if(sql.includes("INSERT INTO whatsapp_sender_coexistence_sync_events")){
      events.add(args[0]);return{rowCount:1};
    }
    if(sql.includes("UPDATE contacts SET whatsapp_profile_name"))return{rowCount:1};
    if(sql.includes("INSERT INTO messages")){
      if(messages.has(args[3]))return{rowCount:0,rows:[]};
      const id=++nextId;messages.set(args[3],{id,role:args[1],
        content:args[2],timestamp:args[5],contactId:args[0]});
      return {rowCount:1,rows:[{id}]};
    }
    if(sql.includes("SELECT m.contact_id FROM messages")){
      const message=messages.get(args[0]);
      return {rows:message?[{contact_id:message.contactId}]:[]};
    }
    if(sql.includes("INSERT INTO whatsapp_sender_message_context"))
      return{rowCount:1};
    return{rows:[],rowCount:1};
  };
  const database={query:q,async connect(){return{query:q,release(){}};}};
  const conversations={
    claimSenderContact:async(params)=>{
      calls.push({claim:params});return contact;
    }
  };
  const importJobs=(opts)=>history.runOnce({...opts,conversations,maxJobs:3});
  return {database,jobs,messages,calls,importJobs,contact};
}

test("handoff is default OFF and demands independently pinned destination and explicit approval",()=>{
  assert.throws(()=>handoff.configForHandoff(env({
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED:"false"
  })),/disabled/);
  assert.throws(()=>handoff.configForHandoff(env({
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED:"false"
  })),/disabled/);
  assert.throws(()=>handoff.configForHandoff(env({
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST:"ep-wrong.neon.tech"
  })),/destination/);
  assert.throws(()=>handoff.configForHandoff(env({
    PR395_STAGING_MODE:"false"
  })),/destination/);
  assert.doesNotThrow(()=>handoff.configForHandoff(env({
    PR395_STAGING_MODE:"false",
    WHATSAPP_CAPTURE_TO_INBOX_PRODUCTION_APPROVED:"true"
  })));
  assert.throws(()=>handoff.configForHandoff(env({
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"
  })),/outbound/);
  // Capture receipt may accept non-history events; each actual history event
  // must still pass the separate verified history-consent gate at capture.
  assert.throws(()=>capture.classify({object:"whatsapp_business_account",entry:[{
    id:"889900",changes:[change("history")]
  }]},capture.captureConfig(env({
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"false"
  }))),/history\/contact consent/);
});

test("encrypted history reaches only second-number Inbox without billing or sending",async()=>{
  const src=sourceDb([encrypted()]);
  const dest=targetDb();
  const result=await handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database,
    importJobs:dest.importJobs,processInboxJobs:true
  });
  assert.equal(result.transferred,1);
  assert.equal(result.importer.processed,1);
  assert.equal(dest.jobs.size,1);
  assert.equal(dest.messages.size,2);
  assert.equal(dest.messages.get("wamid.synthetic-customer").role,"user");
  assert.equal(dest.messages.get("wamid.synthetic-staff").role,"assistant");
  assert.equal(dest.messages.get("wamid.synthetic-customer").timestamp,
    Number(timestamp()));
  assert.equal(src.rows[0].handoff_completed_at,true);
  assert.equal(dest.calls.filter(c=>c.claim).length,1);
  assert.deepEqual(dest.calls.find(c=>c.claim).claim,{
    accountId:"889900",phoneNumberId:"112233",customerPhone:"60126662222"
  });
  assert.ok(!dest.calls.some(c=>/INSERT INTO (?:follow|whatsapp_sender_billing|scheduled)/i.test(c.sql||"")));
  const again=await handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database,
    importJobs:dest.importJobs,processInboxJobs:true
  });
  assert.equal(again.transferred,0);
  assert.equal(dest.messages.size,2);
});
test("contact-only sync stages and imports sender-qualified contacts, never messages",async()=>{
  const src=sourceDb([encrypted("smb_app_state_sync")]);
  const dest=targetDb();
  const r=await handoff.handoffOnce({env:env(),sourceDatabase:src,
    targetDatabase:dest.database,processInboxJobs:true,importJobs:dest.importJobs});
  assert.equal(r.importer.processed,1);
  assert.equal(dest.messages.size,0);
  assert.equal(dest.calls.filter(c=>c.claim).length,1);
  assert.ok(dest.calls.some(c=>c.sql?.includes("UPDATE contacts SET whatsapp_profile_name")));
});
test("crash after durable staging but before source checkpoint safely replays",async()=>{
  const src=sourceDb([encrypted()],{checkpointFail:true});
  const dest=targetDb();
  await assert.rejects(handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database
  }),/checkpoint interrupted/);
  assert.equal(src.rows[0].handoff_completed_at,undefined);
  assert.equal(dest.jobs.size,1);
  assert.ok(src.queries.some(q=>q.sql==="ROLLBACK"));
  const retry=await handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database,
    importJobs:dest.importJobs,processInboxJobs:true
  });
  assert.equal(retry.transferred,1);
  assert.equal(dest.jobs.size,1);
  assert.equal(dest.messages.size,2);
});
test("tampered ciphertext, source phone mismatch and target failure never checkpoint",async()=>{
  for(const mutant of [
    row=>{row.auth_tag=Buffer.alloc(16,0);},
    row=>{row.event_field="smb_app_state_sync";},
    row=>{row.fingerprint="f".repeat(64);}
  ]){
    const row=encrypted();mutant(row);
    const src=sourceDb([row]);const dest=targetDb();
    await assert.rejects(handoff.handoffOnce({
      env:env(),sourceDatabase:src,targetDatabase:dest.database
    }));
    assert.equal(src.rows[0].handoff_completed_at,undefined);
    assert.equal(dest.jobs.size,0);
  }
  const src=sourceDb([encrypted()]);const dest=targetDb();
  await assert.rejects(handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database,
    stage:()=>{throw Error("target unavailable");}
  }),/target unavailable/);
  assert.equal(src.rows[0].handoff_completed_at,undefined);
});
test("620 history messages are encrypted into seven bounded, replayable Inbox jobs",async()=>{
  const bulk=Array.from({length:620},(_,i)=>({
    id:"wamid.synthetic-bulk-"+i,
    from:"60126662222",timestamp:timestamp(),
    type:"text",text:{body:"Historical message "+i}
  }));
  const synthetic={object:"whatsapp_business_account",entry:[{
    id:"889900",time:1790000000,changes:[change("history",bulk)]
  }]};
  const jobs=capture.classify(synthetic,capture.captureConfig(env()));
  const encryptedRows=jobs.map(job=>{
    const e=capture.encryptJob(job,Buffer.alloc(32,29));
    return {fingerprint:e.fingerprint,sender_id:9,event_field:e.field,
      ciphertext:e.ciphertext,nonce:e.nonce,auth_tag:e.tag,payload_bytes:e.bytes};
  });
  const src=sourceDb(encryptedRows);
  const dest=targetDb();
  const staged=await handoff.handoffOnce({
    env:env(),sourceDatabase:src,targetDatabase:dest.database,maxEvents:10
  });
  assert.equal(staged.transferred,7);
  assert.equal(dest.jobs.size,7);
  assert.deepEqual([...dest.jobs.values()].map(j=>
    j.payload.change.value.history[0].threads[0].messages.length),
    [100,100,100,100,100,100,20]);
  assert.equal(dest.messages.size,0);
  let processed=0;
  for(let i=0;i<3;i++){
    const result=await dest.importJobs({
      database:dest.database,env:handoff.configForHandoff(env()).importEnv
    });
    processed+=result.processed;
  }
  assert.equal(processed,7);
  assert.equal(dest.messages.size,620);
});
test("live messages/echoes never become a passive history job",async()=>{
  const src=sourceDb([encrypted("messages"),encrypted("smb_message_echoes")]);
  const dest=targetDb();
  const r=await handoff.handoffOnce({env:env(),sourceDatabase:src,
    targetDatabase:dest.database});
  assert.equal(r.transferred,0);
  assert.equal(src.rows.some(r=>r.handoff_completed_at),false);
  assert.equal(dest.jobs.size,0);
  assert.equal(dest.messages.size,0);
});
