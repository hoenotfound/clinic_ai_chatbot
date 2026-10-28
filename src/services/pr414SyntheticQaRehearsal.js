"use strict";

// One-off QA-only synthetic proof of encrypted capture -> durable handoff ->
// sender-qualified Inbox history. All fixtures are deleted in finally.
// No provider, token, media fetch, Meta API, or outbound customer calls.
const crypto = require("node:crypto");
const {pool: target} = require("../db/db");
const ingress = require("./whatsappPaidDefaultIngress");
const capture = require("./whatsappSecondaryQaCapture");
const handoff = require("./whatsappSecondaryCaptureHandoff");
const synthetic = Object.freeze({
  primaryWaba:"910000000000001",primaryPhone:"910000000000002",
  waba:"910000000000003",phone:"910000000000004",
  primaryE164:"+60129999901",business:"+60129999902",
  customer:"60129999903",key:"coexistence_qa"
});
const OUTBOUND = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_FEP_FOLLOWUPS_ENABLED"
];

function assertRehearsalIsolation(env=process.env) {
  if (env.PR395_STAGING_MODE!=="true" ||
      env.PR414_QA_SYNTHETIC_REHEARSAL_ON_BOOT!=="true" ||
      env.PR414_QA_SYNTHETIC_OPERATOR_APPROVED!=="true" ||
      env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED==="true" ||
      env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING==="true" ||
      env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED==="true" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED==="true" ||
      env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED==="true" ||
      OUTBOUND.some(k=>env[k]==="true") ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE!=="neondb" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE!=="pr414_forward_qa" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ALLOW_SAME_QA_HOST!=="true") {
    throw Error("PR414 rehearsal needs explicitly approved isolated staging with every real customer action disabled");
  }
  let s,t;
  try {
    s=new URL(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL);
    t=new URL(env.DATABASE_URL);
  }catch(_) {throw Error("PR414 rehearsal requires two valid QA Neon URLs");}
  if(s.hostname!==t.hostname || !s.hostname.endsWith(".neon.tech") ||
     s.hostname!==env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST ||
     t.hostname!==env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST ||
     s.pathname!=="/neondb" || t.pathname!=="/pr414_forward_qa" ||
     s.username===t.username || s.password===t.password ||
     !s.password || !t.password) {
    throw Error("PR414 rehearsal refused mismatched QA database host, name or role");
  }
  return true;
}
async function one(database,query,params=[]){
  const r=await database.query(query,params);
  return r.rows?.[0];
}
async function assertBlank(source){
  const [src,dest]=await Promise.all([
    one(source,"SELECT (SELECT COUNT(*)::int FROM whatsapp_sender_accounts) AS senders, (SELECT COUNT(*)::int FROM whatsapp_secondary_qa_capture_events) AS captures, (SELECT MAX(version)::int FROM schema_migrations) AS version"),
    one(target,"SELECT (SELECT COUNT(*)::int FROM whatsapp_sender_accounts) AS senders, (SELECT COUNT(*)::int FROM contacts) AS contacts, (SELECT COUNT(*)::int FROM messages) AS messages, (SELECT COUNT(*)::int FROM whatsapp_sender_coexistence_import_jobs) AS jobs, (SELECT MAX(version)::int FROM schema_migrations) AS version")
  ]);
  if(src.version!==104||dest.version!==106||src.senders!==0||src.captures!==0||
     dest.senders!==0||dest.contacts!==0||dest.messages!==0||dest.jobs!==0) {
    throw Error("PR414 rehearsal refused pre-existing or mismatched QA records");
  }
}
async function cleanup(source) {
  // Exact synthetic sender IDs only, never a broad truncate or schema rollback.
  await source.query(
    "DELETE FROM whatsapp_secondary_qa_capture_events WHERE sender_id IN "+
    "(SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_account_id=$2 AND meta_phone_number_id=$3)",
    [synthetic.key,synthetic.waba,synthetic.phone]);
  for (const table of [
    "whatsapp_sender_coexistence_history_messages",
    "whatsapp_sender_coexistence_sync_events",
    "whatsapp_sender_coexistence_import_jobs"
  ]) {
    await target.query(
      "DELETE FROM "+table+" WHERE sender_id IN "+
      "(SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_account_id=$2 AND meta_phone_number_id=$3)",
      [synthetic.key,synthetic.waba,synthetic.phone]
    );
  }
  await target.query(
    "DELETE FROM contacts WHERE whatsapp_sender_id IN "+
    "(SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_account_id=$2 AND meta_phone_number_id=$3)",
    [synthetic.key,synthetic.waba,synthetic.phone]);
  await target.query(
    "DELETE FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_account_id=$2 AND meta_phone_number_id=$3",
    [synthetic.key,synthetic.waba,synthetic.phone]);
  await source.query(
    "DELETE FROM whatsapp_sender_accounts WHERE sender_key=$1 AND meta_account_id=$2 AND meta_phone_number_id=$3",
    [synthetic.key,synthetic.waba,synthetic.phone]);
}
async function runOnBoot(env=process.env){
  assertRehearsalIsolation(env);
  const syntheticEnv={
    ...env,
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_WABA_ID:synthetic.primaryWaba,
    WHATSAPP_PHONE_NUMBER_ID:synthetic.primaryPhone,
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:synthetic.primaryE164,
    WHATSAPP_PHONE_NUMBER:synthetic.primaryE164,
    WHATSAPP_APP_SECRET:"synthetic-app-secret-".repeat(2),
    META_APP_SECRET:"synthetic-app-secret-".repeat(2),
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"synthetic-verify-token-".repeat(2),
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:synthetic.business,
    WHATSAPP_PAID_SECONDARY_QA_WABA_ID:synthetic.waba,
    WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:synthetic.phone,
    WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:synthetic.business,
    WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:crypto.randomBytes(32).toString("base64"),
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED:"true",
    WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED:"true",
    WHATSAPP_SECONDARY_WABA_ID:"",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false"
  };
  const sourceConfig=ingress.assertQaConfiguration(ingress.configFromEnv(syntheticEnv));
  const source=ingress.getQaPool(sourceConfig);
  await assertBlank(source);
  let fixturesCreated=false, passed=false;
  try{
    const info=[synthetic.key,synthetic.phone,synthetic.waba,"PR414 synthetic only"];
    await source.query(
      "INSERT INTO whatsapp_sender_accounts (sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled) "+
      "VALUES ($1,$2,$3,$4,'testing',TRUE)",info);
    fixturesCreated=true;
    await target.query(
      "INSERT INTO whatsapp_sender_accounts (sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled) "+
      "VALUES ($1,$2,$3,$4,'active',TRUE)",info);
    const when=Math.floor(Date.now()/1000)-3600;
    const histories=[{
      id:"wamid.pr414-synthetic-inbound001",type:"text",timestamp:String(when),
      from:synthetic.customer,to:synthetic.business,text:{body:"Synthetic historical hello"}
    },{
      id:"wamid.pr414-synthetic-outbound001",type:"text",timestamp:String(when+10),
      from:synthetic.business,to:synthetic.customer,text:{body:"Synthetic historical reply"}
    },{
      id:"wamid.pr414-synthetic-media001",type:"image",timestamp:String(when+20),
      from:synthetic.customer,to:synthetic.business,image:{id:"synthetic-no-download"}
    }];
    const body={object:"whatsapp_business_account",entry:[{
      id:synthetic.waba,time:when+30,changes:[
        {field:"history",value:{metadata:{phone_number_id:synthetic.phone},
          history:[{phase:1,progress:100,threads:[{id:synthetic.customer,messages:histories}]}]}},
        {field:"smb_app_state_sync",value:{metadata:{phone_number_id:synthetic.phone},
          state_sync:[{type:"contact",action:"add",contact:{
            phone_number:synthetic.customer,full_name:"PR414 Synthetic Visitor"}}]}}
      ]
    }]};
    const captureResult=await capture.captureSignedSecondaryBatch(body,{
      env:syntheticEnv,database:source,signatureVerified:true
    });
    if(!captureResult.durable || captureResult.accepted!==2 || captureResult.inserted!==2)
      throw Error("Synthetic encrypted capture did not stage exactly two events");
    const first=await handoff.handoffOnce({
      env:syntheticEnv,sourceDatabase:source,targetDatabase:target,
      maxEvents:3,processInboxJobs:true
    });
    if(first.transferred!==2 || first.importer?.processed!==2 ||
       first.importer?.failed!==0 || first.noCustomerMessagesSent!==true)
      throw Error("Synthetic handoff or Inbox importer did not complete exactly twice");
    const saved=await target.query(
      "SELECT m.role,m.content,EXTRACT(EPOCH FROM m.source_created_at)::bigint AS original_epoch, "+
      "m.whatsapp_message_id,c.whatsapp_profile_name,sc.customer_wa_id "+
      "FROM messages m JOIN contacts c ON m.contact_id=c.id "+
      "JOIN whatsapp_sender_message_context ctx ON ctx.message_id=m.id "+
      "JOIN whatsapp_sender_conversations sc ON sc.id=ctx.conversation_id "+
      "JOIN whatsapp_sender_accounts s ON s.id=sc.sender_id "+
      "WHERE s.sender_key=$1 AND s.meta_account_id=$2 ORDER BY m.source_created_at",
      [synthetic.key,synthetic.waba]
    );
    const rows=saved.rows||[];
    if(rows.length!==3 || rows[0].role!=="user" ||
       rows[1].role!=="assistant" || rows[2].role!=="user" ||
       rows[0].original_epoch!==String(when) &&
       Number(rows[0].original_epoch)!==when ||
       rows[2].content!=="[image from WhatsApp Business App history: media not imported]" ||
       rows.some(r=>r.whatsapp_profile_name!=="PR414 Synthetic Visitor"||
         r.customer_wa_id!==synthetic.customer))
      throw Error("Synthetic Inbox history, identity, timestamps or media placeholder mismatch");
    const replay=await capture.captureSignedSecondaryBatch(body,{
      env:syntheticEnv,database:source,signatureVerified:true
    });
    const duplicate=await handoff.handoffOnce({
      env:syntheticEnv,sourceDatabase:source,targetDatabase:target,
      maxEvents:3,processInboxJobs:true
    });
    if(replay.inserted!==0||duplicate.transferred!==0 ||
       Number((await one(target,"SELECT COUNT(*)::int AS n FROM messages")).n)!==3)
      throw Error("Synthetic encrypted callback replay created duplicate Inbox messages");
    const guard=await one(target,
      "SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts");
    if(guard.n!==0)throw Error("Synthetic rehearsal unexpectedly created billing rows");
    passed=true;
    console.log("[PR414 QA synthetic] PASS encrypted capture=2, handoff=2, Inbox messages=3, identity/timestamps/contacts/media/replay/billing guarded; no Meta API or sends.");
    return{passed:true};
  }finally{
    if(fixturesCreated){
      await cleanup(source);
      await assertBlank(source);
      console.log("[PR414 QA synthetic] Synthetic source/target QA rows cleaned; migrations 104/106 unchanged.");
    }
    if(!passed)console.error("[PR414 QA synthetic] FAILED; no real Meta or customer actions were attempted.");
  }
}
module.exports={assertRehearsalIsolation,runOnBoot};
