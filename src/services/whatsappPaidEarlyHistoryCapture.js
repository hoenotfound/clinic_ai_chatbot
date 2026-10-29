"use strict";

// Opt-in, short-lived and encrypted *pre-identity* holding area on the existing
// paid app-default webhook. A signed event with the intended display number
// is NOT proof of ownership. Nothing in this module creates contacts, sends
// messages or treats an unverified WABA as Neutro.
const crypto = require("node:crypto");
const {pool} = require("../db/db");
const vault = require("./whatsappCoexistenceCredentialVault");
const history = require("./whatsappCoexistenceHistoryService");
const paid = require("./whatsappPaidDefaultIngress");
const verifiedReceiver = require("./whatsappPaidProductionHistoryReceiver");

const TARGET = "+60174831336";
const FIELDS = new Set(["history", "smb_app_state_sync"]);
const MAX_CHANGE_BYTES = 8 * 1024 * 1024;
const MAX_CHANGES = 100;

// After the short-lived capture deadline, stop selecting this receiver.
// Other signed app-default traffic should return to the existing guarded router
// rather than be rejected by a now-expired capture configuration.
function enabled(env=process.env,now=new Date()) {
  if(env.WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED !== "true") return false;
  const until=new Date(env.WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL||"").getTime();
  const at=new Date(now).getTime();
  return Number.isFinite(until) && Number.isFinite(at) && until>at;
}
function digits(v) {
  if (typeof v !== "string" || !/^\+?[0-9\s().-]{8,28}$/.test(v)) return null;
  return v.replace(/\D/g, "");
}
function numeric(v) { return typeof v === "string" && /^\d{1,32}$/.test(v); }
function assertCaptureConfig(env=process.env,now=new Date()) {
  if (!enabled(env,now)) throw Error("Early capture is OFF or expired");
  const until = new Date(env.WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL || "");
  const nowMs = new Date(now).getTime();
  if (env.PR395_STAGING_MODE === "true" ||
      env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED !== "true" ||
      verifiedReceiver.configured(env) ||
      env.WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED !== "true" ||
      env.WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED !== "true" ||
      env.WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED !== "true" ||
      env.WHATSAPP_PRIMARY_SENDER_KEY !== "neutro" ||
      env.WHATSAPP_SECONDARY_SENDER_KEY !== "neutro_secondary" ||
      env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 !== TARGET ||
      !numeric(env.WHATSAPP_WABA_ID) || !numeric(env.WHATSAPP_PHONE_NUMBER_ID) ||
      digits(env.WHATSAPP_PHONE_NUMBER) === digits(TARGET) ||
      !Number.isFinite(nowMs) || !Number.isFinite(until.getTime()) ||
      until.getTime() <= nowMs || until.getTime()-nowMs > 24*3600000 ||
      env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_STAFF_SEND_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_AI_SEND_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED === "true" ||
      env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED === "true" ||
      env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED === "true") {
    throw Error("Early Neutro history capture preconditions not verified");
  }
  const secret=env.WHATSAPP_APP_SECRET;
  if(typeof secret !== "string" || secret.length<24 || env.META_APP_SECRET !== secret)
    throw Error("Meta HMAC secret mismatch");
  // The existing production credential vault already requires a separate
  // vetted key. HKDF uses a purpose-specific context to isolate this data.
  const master = vault.keyFromEnv(env);
  const key = Buffer.from(crypto.hkdfSync("sha256",master,
    Buffer.from("neutro-secondary-early-history-v1"),
    Buffer.from("encrypted-unverified-meta-history"),32));
  return {secret,key,primaryWaba:env.WHATSAPP_WABA_ID,
    primaryPhone:env.WHATSAPP_PHONE_NUMBER_ID};
}
function partition(body,config) {
  if (body?.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || !body.entry.length || body.entry.length>MAX_CHANGES)
    throw Error("Invalid early history batch");
  const selected=[],remaining=[];let total=0;
  for(const entry of body.entry) {
    if (!numeric(entry?.id) || !Array.isArray(entry.changes) ||
        !entry.changes.length || entry.changes.length>MAX_CHANGES)
      throw Error("Malformed early Meta entry");
    const early=[],other=[];
    for(const change of entry.changes) {
      if (++total>MAX_CHANGES || !change || typeof change.field!=="string" ||
          !change.value || typeof change.value!=="object" || Array.isArray(change.value))
        throw Error("Malformed early Meta change");
      const meta=change.value.metadata;
      const isTarget=FIELDS.has(change.field) &&
        digits(meta?.display_phone_number) === digits(TARGET);
      if (FIELDS.has(change.field) && entry.id!==config.primaryWaba && !isTarget)
        throw Error("Unattributed foreign history cannot be acknowledged");
      if (isTarget) {
        if(!numeric(meta?.phone_number_id) ||
           entry.id===config.primaryWaba ||
           meta.phone_number_id===config.primaryPhone)
          throw Error("Early event cannot be bound to a separate candidate");
        early.push(change);
      } else {
        other.push(change);
      }
    }
    if(early.length)selected.push({...entry,changes:early});
    if(other.length)remaining.push({...entry,changes:other});
  }
  return {
    selected:selected.length?{object:body.object,entry:selected}:null,
    remaining:remaining.length?{object:body.object,entry:remaining}:null
  };
}
function fingerprint(account,change) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({account,change})).digest("hex");
}
function aad(fp,waba,phone) {
  return Buffer.from("neutro-secondary-early-v1:"+fp+":"+waba+":"+phone);
}
function seal(account,change,key) {
  const json=Buffer.from(JSON.stringify({accountId:account,change}),"utf8");
  if(!json.length || json.length>MAX_CHANGE_BYTES)throw Error("Early history chunk too large");
  const fp=fingerprint(account,change);
  const nonce=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv("aes-256-gcm",key,nonce);
  const phone=change.value.metadata.phone_number_id;
  cipher.setAAD(aad(fp,account,phone));
  const ciphertext=Buffer.concat([cipher.update(json),cipher.final()]);
  json.fill(0);
  return {fp,nonce,ciphertext,tag:cipher.getAuthTag(),phone};
}
// Split large but valid Meta history/contact arrays into bounded encrypted
// holds. Preserve every child and its identity/progress metadata; either all
// rows commit before HTTP 200 or the transaction rolls back (Meta may retry).
function divideForHold(change) {
  const field=change.field==="history"?"history":
    change.field==="smb_app_state_sync"?"state_sync":null;
  const items=field&&change.value?.[field];
  if(!Array.isArray(items)||!items.length)
    throw Error("Oversized early history without splittable data");
  let left,right;
  if(items.length>1){
    const pivot=Math.ceil(items.length/2);
    left=items.slice(0,pivot);right=items.slice(pivot);
  }else if(field==="history" && Array.isArray(items[0]?.threads)){
    const part=items[0],threads=part.threads;
    if(threads.length>1){
      const pivot=Math.ceil(threads.length/2);
      left=[{...part,threads:threads.slice(0,pivot)}];
      right=[{...part,threads:threads.slice(pivot)}];
    }else if(threads.length===1 && Array.isArray(threads[0]?.messages) &&
             threads[0].messages.length>1){
      const thread=threads[0],pivot=Math.ceil(thread.messages.length/2);
      left=[{...part,threads:[{...thread,messages:thread.messages.slice(0,pivot)}]}];
      right=[{...part,threads:[{...thread,messages:thread.messages.slice(pivot)}]}];
    }
  }
  if(!left||!right)throw Error("Single oversized Meta history item cannot be safely split");
  return [
    {...change,value:{...change.value,[field]:left}},
    {...change,value:{...change.value,[field]:right}}
  ];
}
function splitForHold(account,change) {
  const pending=[change],out=[];
  while(pending.length){
    if(pending.length+out.length>128)
      throw Error("Too many early history fragments; refuse without ACK");
    const part=pending.shift();
    const bytes=Buffer.byteLength(JSON.stringify({accountId:account,change:part}),"utf8");
    if(bytes>=1 && bytes<=MAX_CHANGE_BYTES){out.push(part);continue;}
    pending.unshift(...divideForHold(part));
  }
  return out;
}
function unseal(row,key) {
  if(!/^[a-f0-9]{64}$/.test(row.fingerprint) ||
     !numeric(row.candidate_waba_id) || !numeric(row.candidate_phone_number_id) ||
     !Buffer.isBuffer(row.nonce) || row.nonce.length!==12 ||
     !Buffer.isBuffer(row.auth_tag) || row.auth_tag.length!==16 ||
     !Buffer.isBuffer(row.ciphertext) ||
     !Number.isSafeInteger(row.payload_bytes) || row.payload_bytes<1 ||
     row.payload_bytes>MAX_CHANGE_BYTES)throw Error("Corrupt early history hold");
  const cipher=crypto.createDecipheriv("aes-256-gcm",key,row.nonce);
  cipher.setAAD(aad(row.fingerprint,row.candidate_waba_id,row.candidate_phone_number_id));
  cipher.setAuthTag(row.auth_tag);
  const clear=Buffer.concat([cipher.update(row.ciphertext),cipher.final()]);
  try{
    if(clear.length!==row.payload_bytes)throw Error("Wrong early history payload size");
    const parsed=JSON.parse(clear.toString("utf8"));
    if(parsed.accountId!==row.candidate_waba_id ||
       !FIELDS.has(parsed.change?.field) ||
       parsed.change?.field!==row.event_field ||
       parsed.change.value?.metadata?.phone_number_id!==row.candidate_phone_number_id ||
       digits(parsed.change.value?.metadata?.display_phone_number)!==digits(TARGET) ||
       fingerprint(parsed.accountId,parsed.change)!==row.fingerprint)
      throw Error("Early hold identity mismatch");
    return parsed;
  }finally{clear.fill(0);}
}
async function stage(body,{env=process.env,database=pool,now=new Date()}={}) {
  const config=assertCaptureConfig(env,now);
  const {selected}=partition(body,config);
  if(!selected)return {durable:true,inserted:0};
  const client=await database.connect();let active=false;let inserted=0;
  try{
    await client.query("BEGIN");active=true;
    await client.query("DELETE FROM whatsapp_secondary_early_history_hold WHERE expires_at<=NOW()");
    let fragments=0;
    for(const entry of selected.entry)for(const change of entry.changes)
    for(const piece of splitForHold(entry.id,change)){
      if(++fragments>128)throw Error("Early history hold fragment limit exceeded");
      const sealed=seal(entry.id,piece,config.key);
      const result=await client.query(
        "INSERT INTO whatsapp_secondary_early_history_hold " +
        "(fingerprint,candidate_waba_id,candidate_phone_number_id,event_field,nonce,ciphertext,auth_tag,payload_bytes) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint",
        [sealed.fp,entry.id,sealed.phone,change.field,sealed.nonce,
          sealed.ciphertext,sealed.tag,sealed.ciphertext.length]
      );
      inserted+=result.rowCount;
    }
    await client.query("COMMIT");active=false;
    return {durable:true,inserted};
  }catch(e){
    if(active)await client.query("ROLLBACK").catch(()=>{});
    throw e;
  }finally{client.release();}
}
async function dispatch(req,res,primaryHandler,{
  env=process.env,database=pool,now=new Date(),
  dispatchPrimary=paid.dispatchDefaultWebhook,
  stageEarlyHistory=stage
}={}){
  const config=assertCaptureConfig(env,now);
  verifiedReceiver.assertSigned(req,config.secret);
  if(typeof primaryHandler!=="function")throw Error("Primary handler required");
  const {selected,remaining}=partition(req.body,config);
  if(!selected)return dispatchPrimary(req,res,primaryHandler,{env});
  const result=await stageEarlyHistory(selected,{database,env,now});
  if(result?.durable!==true)throw Error("Early history was not durable");
  if(remaining)return dispatchPrimary({...req,body:remaining},res,primaryHandler,{env});
  return res.sendStatus(200);
}
// Manual ONLY, after authenticated Meta onboarding, exact sender registration,
// verified history consent and PR425's strict production receiver are active.
// History is staged and held ciphertext removed in ONE database transaction.
async function handoffOnce({
  env=process.env,database=pool,maxEvents=5,
  stageHistory=history.acceptPassiveSync
}={}){
  const exact=verifiedReceiver.assertConfig(env);
  if(env.WHATSAPP_PAID_SECONDARY_EARLY_HANDOFF_OPERATOR_APPROVED!=="true")
    throw Error("Manual encrypted early-history handoff is not approved");
  if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>10)
    throw Error("Invalid bounded handoff size");
  const key=Buffer.from(crypto.hkdfSync("sha256",vault.keyFromEnv(env),
    Buffer.from("neutro-secondary-early-history-v1"),
    Buffer.from("encrypted-unverified-meta-history"),32));
  let transferred=0;
  for(let i=0;i<maxEvents;i++){
    const client=await database.connect();let active=false;let found=false;
    try{
      await client.query("BEGIN");active=true;
      const attested=await client.query(
        "SELECT a.id FROM whatsapp_coexistence_onboarding_attempts a " +
        "JOIN whatsapp_coexistence_onboarding_credentials c ON c.attempt_id=a.id " +
        "AND c.waba_id=a.waba_id AND c.phone_number_id=a.phone_number_id " +
        "WHERE a.status='validated' AND a.coexistence_ready=TRUE " +
        "AND a.waba_id=$1 AND a.phone_number_id=$2 " +
        "AND regexp_replace(a.display_phone_number,'[^0-9]','','g')=$3 " +
        "AND c.token_expires_at>NOW() ORDER BY a.id DESC LIMIT 1",
        [exact.secondaryAccount,exact.secondaryPhone,digits(TARGET)]
      );
      if(attested.rows?.length!==1)throw Error("Authenticated Meta signup identity not verified");
      const sender=await client.query(
        "SELECT id FROM whatsapp_sender_accounts WHERE sender_key='neutro_secondary' " +
        "AND meta_account_id=$1 AND meta_phone_number_id=$2 " +
        "AND state='active' AND coexistence_enabled=TRUE",
        [exact.secondaryAccount,exact.secondaryPhone]
      );
      if(sender.rows?.length!==1)throw Error("Verified secondary sender missing");
      const held=await client.query(
        "SELECT fingerprint,candidate_waba_id,candidate_phone_number_id,event_field," +
        "nonce,ciphertext,auth_tag,payload_bytes FROM whatsapp_secondary_early_history_hold " +
        "WHERE candidate_waba_id=$1 AND candidate_phone_number_id=$2 " +
        "AND expires_at>NOW() ORDER BY received_at,fingerprint LIMIT 1 FOR UPDATE SKIP LOCKED",
        [exact.secondaryAccount,exact.secondaryPhone]
      );
      const row=held.rows?.[0];
      if(row){
        found=true;
        const parsed=unseal(row,key);
        const payload={object:"whatsapp_business_account",
          entry:[{id:exact.secondaryAccount,changes:[parsed.change]}]};
        const staged=await stageHistory(payload,{database:client,env});
        if(staged?.enabled!==true)throw Error("Verified history importer declined hold");
        const chunks=[...new Set(history.splitHistoryChange(parsed.change)
          .map(change=>history.fingerprint(exact.secondaryAccount,change)))];
        if(!chunks.length || chunks.length>2000)throw Error("Invalid verified history chunks");
        const verified=await client.query(
          "SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs " +
          "WHERE sender_id=$1 AND fingerprint=ANY($2::text[]) " +
          "AND status IN ('pending','processing','completed')",
          [sender.rows[0].id,chunks]
        );
        if(verified.rows?.[0]?.n!==chunks.length)
          throw Error("A history chunk is not durably staged");
        const removed=await client.query(
          "DELETE FROM whatsapp_secondary_early_history_hold WHERE fingerprint=$1 " +
          "AND candidate_waba_id=$2 AND candidate_phone_number_id=$3",
          [row.fingerprint,exact.secondaryAccount,exact.secondaryPhone]
        );
        if(removed.rowCount!==1)throw Error("Verified handoff deletion failed");
      }
      await client.query("COMMIT");active=false;
      if(!found)break;
      transferred++;
    }catch(e){
      if(active)await client.query("ROLLBACK").catch(()=>{});
      throw e;
    }finally{client.release();}
  }
  return {transferred,noMessagesSent:true};
}
async function purgeExpired({database=pool}={}) {
  return database.query(
    "DELETE FROM whatsapp_secondary_early_history_hold WHERE expires_at<=NOW() RETURNING fingerprint"
  );
}
module.exports={enabled,assertCaptureConfig,partition,fingerprint,seal,unseal,splitForHold,stage,dispatch,handoffOnce,purgeExpired,TARGET};
