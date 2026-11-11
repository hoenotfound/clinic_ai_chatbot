"use strict";
// Durable, ownership-checked R2 cleanup for revoked customer attachments.
// Reuses the existing customer media cleanup worker. Never deletes a file
// still referenced by another message or from a different client/contact.
const crypto = require("node:crypto");
const {pool} = require("../db/db");
const storage = require("./mediaStorageService");
const LEASE_MINUTES = 10;

function safeContactKey(key, contactId, env = process.env, media = storage) {
  if (!Number.isSafeInteger(Number(contactId)) || Number(contactId) < 1) return false;
  if (!media.isOwnedStoredMediaKey(key, env) ||
      media.isSharedFollowUpConfigKey(key, env)) return false;
  const isolation = media.getMediaIsolationStatus(env);
  const base = isolation.prefix ? `${isolation.prefix}/` : "";
  return String(key || "").startsWith(`${base}messages/${contactId}/`);
}

async function getNextDueAt(database = pool) {
  const result = await database.query(
    `SELECT MIN(CASE
        WHEN status IN ('pending','failed') THEN next_attempt_at
        WHEN status='processing' THEN claimed_at +
          ($1::integer * interval '1 minute')
      END) AS due_at
      FROM whatsapp_customer_revoked_media_cleanup
      WHERE status IN ('pending','failed','processing')`,
    [LEASE_MINUTES]
  );
  return result.rows[0]?.due_at || null;
}

async function claimOne({database=pool}={}) {
  const leaseToken=crypto.randomUUID();
  const result=await database.query(
    `WITH next_job AS (
       SELECT id FROM whatsapp_customer_revoked_media_cleanup
       WHERE ((status IN ('pending','failed') AND next_attempt_at<=NOW())
         OR (status='processing' AND claimed_at <=
             NOW()-($2::integer * interval '1 minute')))
       ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_customer_revoked_media_cleanup j
       SET status='processing',attempts=j.attempts+1,
         lease_token=$1,claimed_at=NOW(),updated_at=NOW()
       FROM next_job WHERE j.id=next_job.id RETURNING j.*`,
    [leaseToken,LEASE_MINUTES]
  );
  return result.rows[0]||null;
}

async function finish(job,{database=pool,status,error=null}={}) {
  if(!["completed","skipped","failed"].includes(status)) throw new TypeError("Invalid cleanup result");
  const retrySeconds=Math.min(21600,30*2**Math.min(10,Math.max(0,Number(job.attempts||1)-1)));
  const result=await database.query(
    `UPDATE whatsapp_customer_revoked_media_cleanup
       SET status=$3,
         next_attempt_at=CASE WHEN $3='failed'
           THEN NOW()+($4::integer * interval '1 second')
           ELSE next_attempt_at END,
         media_key=CASE WHEN $3 IN ('completed','skipped') THEN NULL ELSE media_key END,
         last_error=$5,lease_token=NULL,claimed_at=NULL,updated_at=NOW()
       WHERE id=$1 AND status='processing' AND lease_token=$2
       RETURNING id`,
    [job.id,job.lease_token,status,retrySeconds,
     error?String(error.message||error).slice(0,500):null]
  );
  return result.rows.length===1;
}

async function processJob(job,{database=pool,media=storage,env=process.env}={}) {
  try {
    if(!safeContactKey(job.media_key,job.contact_id,env,media)) {
      await finish(job,{database,status:"skipped",error:"Media key outside the verified customer namespace"});
      return "skipped";
    }
    const refs=await database.query(
      `SELECT EXISTS(SELECT 1 FROM messages WHERE media_key=$1) AS still_used`,
      [job.media_key]
    );
    if(refs.rows[0]?.still_used!==false) {
      // Fail closed on incomplete reference evidence, including shared keys.
      await finish(job,{database,status:"skipped",error:"Media key remains referenced or ownership was not established"});
      return "skipped";
    }
    await media.deleteMedia(job.media_key);
    await finish(job,{database,status:"completed"});
    return "completed";
  } catch(error) {
    await finish(job,{database,status:"failed",error});
    return "failed";
  }
}

async function runPending({limit=10,database=pool,media=storage,env=process.env}={}) {
  const cap=Math.max(1,Math.min(20,Number(limit)||10));
  let processed=0,completed=0,skipped=0,failed=0;
  while(processed<cap){
    const job=await claimOne({database});
    if(!job)break;
    processed++;
    const state=await processJob(job,{database,media,env});
    if(state==="completed")completed++;
    else if(state==="skipped")skipped++;
    else failed++;
  }
  return {processed,completed,skipped,failed};
}

module.exports={safeContactKey,getNextDueAt,claimOne,processJob,runPending};
