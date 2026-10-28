"use strict";

// Isolated QA retention only. Never schedule this in Neutro production.
// Does not inspect or expose encrypted customer content.
const {Pool}=require("pg");

const QA_PROJECT="wandering-dream-82267835";
const QA_BRANCH="br-late-sky-ao8xggam";
const TABLE="public.whatsapp_secondary_qa_capture_events";
const SQL=Object.freeze({
  identity:"SELECT current_database() AS database_name, " +
    "to_regclass('public.whatsapp_secondary_qa_capture_events')::text AS target_table," +
    "(SELECT COALESCE(MAX(version),0) FROM public.schema_migrations)::integer AS migration",
  prune:"WITH old AS (" +
    "SELECT fingerprint FROM public.whatsapp_secondary_qa_capture_events " +
    "WHERE expires_at < NOW() ORDER BY expires_at, fingerprint " +
    "LIMIT $1 FOR UPDATE SKIP LOCKED" +
    "), deleted AS (" +
    "DELETE FROM public.whatsapp_secondary_qa_capture_events AS q " +
    "USING old WHERE q.fingerprint=old.fingerprint RETURNING 1" +
    ") SELECT count(*)::integer AS deleted FROM deleted"
});
function retentionConfig(env=process.env) {
  if(env.WHATSAPP_SECONDARY_QA_RETENTION_ENABLED!=="true")
    throw Error("QA retention cleanup disabled");
  if(env.WHATSAPP_SECONDARY_QA_RETENTION_PROJECT_ID!==QA_PROJECT ||
     env.WHATSAPP_SECONDARY_QA_RETENTION_BRANCH_ID!==QA_BRANCH)
    throw Error("QA project/branch identity not pinned");
  const qaUri=String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL||"");
  const prodUri=String(env.DATABASE_URL||"");
  const host=String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST||"").toLowerCase();
  let qa,prod;
  try {qa=new URL(qaUri);prod=new URL(prodUri);}
  catch(_){throw Error("Both QA and production host guards are required");}
  if(!["postgres:","postgresql:"].includes(qa.protocol) ||
     !["postgres:","postgresql:"].includes(prod.protocol) ||
     !qa.username || !qa.password || qa.hostname.toLowerCase()!==host ||
     !host.endsWith(".neon.tech") || prod.hostname.toLowerCase()===host ||
     qaUri===prodUri || qa.pathname!=="/neondb")
    throw Error("Refusing cleanup outside isolated QA Neon");
  return {connectionString:qaUri,batchSize:Math.min(250,Math.max(1,
    Number.parseInt(env.WHATSAPP_SECONDARY_QA_RETENTION_BATCH_SIZE||"100",10)||100))};
}
async function cleanupExpired({env=process.env,database=null,verifyIdentity=true}={}) {
  const cfg=retentionConfig(env);
  const pool=database||new Pool({connectionString:cfg.connectionString,
    ssl:{rejectUnauthorized:true},max:1,
    connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
    statement_timeout:5000,query_timeout:6000,
    application_name:"da-chatbot-secondary-qa-retention"});
  const client=await pool.connect();
  let started=false;
  try{
    await client.query("BEGIN");
    started=true;
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    if(verifyIdentity){
      const info=await client.query(SQL.identity);
      const row=info.rows?.[0];
      if(!row||row.database_name!=="neondb"||
         row.target_table!==TABLE||Number(row.migration)!==104)
        throw Error("QA retention schema identity does not match v104");
    }
    const result=await client.query(SQL.prune,[cfg.batchSize]);
    const deleted=Number(result.rows?.[0]?.deleted);
    if(!Number.isInteger(deleted)||deleted<0||deleted>cfg.batchSize)
      throw Error("Unexpected retention deletion count");
    await client.query("COMMIT");
    started=false;
    return {qaOnly:true,deleted,maxBatch:cfg.batchSize,hasMorePossible:deleted===cfg.batchSize};
  }catch(error){
    if(started)await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{
    client.release();
    if(!database)await pool.end();
  }
}
if(require.main===module){
  cleanupExpired().then(result=>{
    console.log(JSON.stringify(result));
  }).catch(()=>{
    console.error("QA retention failed closed; inspect QA database configuration.");
    process.exitCode=2;
  });
}
module.exports={QA_PROJECT,QA_BRANCH,TABLE,SQL,retentionConfig,cleanupExpired};
