"use strict";

// QA-only passive review of already encrypted webhook captures.
// NO contact/message creation, no AI, no provider request, no history sync POST.
// Reports counters and progress only; never returns customer or message content.
const crypto=require("node:crypto");
const ingress=require("./whatsappPaidDefaultIngress");
const capture=require("./whatsappSecondaryQaCapture");
const MAX_ROWS=100;
const ALLOWED=capture.ALLOWED_FIELDS;

function safeArray(v) {return Array.isArray(v)?v:[];}
function boundedCount(n) {
  if(!Number.isSafeInteger(n)||n<0||n>50000)throw Error("Unbounded sync counter");
  return n;
}
function summarizeChange(field,change) {
  if(!ALLOWED.has(field)||change?.field!==field||
     !change.value||Array.isArray(change.value))throw Error("Malformed QA event");
  const value=change.value;
  const history=safeArray(value.history);
  const states=safeArray(value.state_sync);
  const echoes=safeArray(value.message_echoes).length
    ? safeArray(value.message_echoes):safeArray(value.smb_message_echoes);
  const messages=safeArray(value.messages);
  // Meta may encode phase/progress inside chunk.metadata as strings.
  const ordinal=(v,min,max)=>{
    const n=Number(v);
    return (v===null||v===undefined||v===""||
      !Number.isInteger(n)||n<min||n>max)?null:n;
  };
  const progress=history.map(h=>ordinal(h?.metadata?.progress??h?.progress,0,100))
    .filter(n=>n!==null);
  const phases=history.map(h=>ordinal(h?.metadata?.phase??h?.phase,0,2))
    .filter(n=>n!==null);
  const errors=history.reduce((n,h)=>n+safeArray(h?.errors).length,0);
  const historicalMessages=history.reduce((n,h)=>{
    const threads=safeArray(h?.threads).length?safeArray(h?.threads):
      safeArray(h?.conversations);
    return n+threads.reduce((sum,thread)=>
      sum+safeArray(thread?.messages).length,0);
  },0);
  // Meta state_sync can be one contact event per array member.
  const contactItems=states.reduce((n,s)=>n+
    (s?.type==="contact"&&s?.contact?1:0)+safeArray(s?.contacts).length,0);
  return {
    field,
    historyChunks:boundedCount(history.length),
    historyMessages:boundedCount(historicalMessages),
    historyErrors:boundedCount(errors),
    appStateChunks:boundedCount(states.length),
    appStateContacts:boundedCount(contactItems),
    echoEvents:boundedCount(echoes.length || (field==="smb_message_echoes"?messages.length:0)),
    inboundEvents:boundedCount(field==="messages"?messages.length:0),
    phases:[...new Set(phases)].sort(),
    maxProgress:progress.length?Math.max(...progress):null,
    // Progress is observed payload metadata, never proof that all phases or
    // provider-side synchronization requests completed.
    syncComplete:false
  };
}
function decryptRow(row,key){
  if(!ALLOWED.has(row?.event_field)||
    typeof row.fingerprint!=="string"||
    !/^[0-9a-f]{64}$/.test(row.fingerprint)||
    !Buffer.isBuffer(row.ciphertext)||
    !Buffer.isBuffer(row.nonce)||row.nonce.length!==12||
    !Buffer.isBuffer(row.auth_tag)||row.auth_tag.length!==16||
    !Number.isSafeInteger(row.payload_bytes)||
    row.payload_bytes<1||row.payload_bytes>2097152)
    throw Error("Malformed encrypted QA event");
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,row.nonce);
  decipher.setAAD(Buffer.from(row.fingerprint,"ascii"));
  decipher.setAuthTag(row.auth_tag);
  let plaintext;
  try{
    plaintext=Buffer.concat([decipher.update(row.ciphertext),decipher.final()]);
    if(plaintext.length!==row.payload_bytes)throw Error("Payload length mismatch");
    const parsed=JSON.parse(plaintext.toString("utf8"));
    const result=summarizeChange(row.event_field,parsed.change);
    return result;
  }finally {
    if(plaintext)plaintext.fill(0);
  }
}
async function reviewSecondaryCapture({
  env=process.env,database=null,limit=100
}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>MAX_ROWS)
    throw Error("Invalid bounded QA review size");
  // The event writer and read-only review share exact identity,
  // consent and QA Neon host isolation checks.
  const config=capture.captureConfig(env);
  const pool=database||ingress.getQaPool(config);
  const client=await pool.connect();
  try {
    const check=await client.query(
      "SELECT version,name FROM schema_migrations WHERE version IN (102,103,104)"
    );
    const versions=new Map(check.rows.map(r=>[Number(r.version),r.name]));
    if(versions.get(102)!=="whatsapp_coexistence_preidentity_events"||
       versions.get(103)!=="whatsapp_legacy_lifecycle_relay_audit"||
       versions.get(104)!=="whatsapp_coexistence_once_only_and_lifecycle_alerts")
      throw Error("Wrong isolated QA migration history");
    const sender=await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key='coexistence_qa' " +
      "AND meta_account_id=$1 AND meta_phone_number_id=$2 " +
      "AND state='testing' AND coexistence_enabled=TRUE",
      [config.waba,config.phoneId]);
    if(sender.rows.length!==1)throw Error("Unverified QA secondary sender");
    const rows=await client.query(
      "SELECT fingerprint,event_field,ciphertext,nonce,auth_tag,payload_bytes " +
      "FROM whatsapp_secondary_qa_capture_events " +
      "WHERE sender_id=$1 AND expires_at>NOW() " +
      "ORDER BY received_at,fingerprint LIMIT $2",
      [sender.rows[0].id,limit]);
    const totals={messages:0,smb_message_echoes:0,history:0,smb_app_state_sync:0,
      historyChunks:0,historyMessages:0,historyErrors:0,
      appStateChunks:0,appStateContacts:0,echoEvents:0,inboundEvents:0};
    const phases=new Set();
    let observedProgress=null;
    for(const row of rows.rows) {
      const result=decryptRow(row,config.key);
      totals[result.field]++;
      for(const k of ["historyChunks","historyMessages","historyErrors",
        "appStateChunks","appStateContacts","echoEvents","inboundEvents"])
        totals[k]=boundedCount(totals[k]+result[k]);
      for(const phase of result.phases)phases.add(phase);
      if(result.maxProgress!=null)observedProgress=
        Math.max(observedProgress??0,result.maxProgress);
    }
    return {
      qaOnly:true,readOnly:true,rows:rows.rows.length,
      possiblyTruncated:rows.rows.length===limit,
      counts:totals,historyPhases:[...phases].sort(),
      observedMaxHistoryProgress:observedProgress,
      historyImportComplete:false,
      // Never infer consent, imported history or 24-hour window from counts.
      inboxUpdated:false,aiRepliesSent:false
    };
  }finally{client.release();}
}
module.exports={summarizeChange,decryptRow,reviewSecondaryCapture};
