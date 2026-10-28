"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const monitor=require("../scripts/qa/readOnlyOperationalWebhookQueue.cjs");

function env(patch={}) {
  return {
    WHATSAPP_WABA_ID:"1593376338308612",
    DATABASE_URL:"postgresql://prod:secret@ep-production.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://qa:secret@ep-isolated.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-isolated.aws.neon.tech",
    ...patch
  };
}
function row(field,index=1) {
  return { fingerprint:String(index).padStart(64,"a"),
    event_field:field,first_seen_at:"2026-10-28T02:00:00.000Z" };
}
test("Neutro QA triage never accepts the production database or unpinned host",()=>{
  assert.throws(()=>monitor.configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:env().DATABASE_URL,
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:
      "ep-production.aws.neon.tech"
  })),/Refusing/);
  assert.throws(()=>monitor.configFromEnv(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-attacker.neon.tech"
  })),/Refusing/);
  assert.equal(monitor.configFromEnv(env()).accountId,"1593376338308612");
});
test("all subscribed notification categories receive a manual action without payload",()=>{
  assert.equal(monitor.FIELDS.length,8);
  const summary=monitor.summarize(monitor.FIELDS.map((f,i)=>row(f,i+1)));
  assert.equal(summary.length,8);
  assert.ok(summary.every(x=>x.requiresManualReview &&
    typeof x.action==="string" && x.action.length>10));
  assert.equal(summary[0].field,"security");
  assert.equal(summary[0].severity,"urgent");
  assert.equal(summary.at(-1).severity,"review");
  assert.ok(summary.every(x=>!Object.hasOwn(x,"payload")));
});
test("operator report runs one SELECT-only bounded, pinned query against QA",async()=>{
  const queries=[];
  const database={
    async query(sql,params){
      queries.push({sql,params});
      return {rows:[row("security"),row("calls",2)]};
    }
  };
  const result=await monitor.inspect({env:env(),database,limit:15,lookbackHours:48});
  assert.equal(result.source,"isolated-QA-only");
  assert.equal(result.readOnly,true);
  assert.equal(result.returned,2);
  assert.equal(result.notifications[0].severity,"urgent");
  assert.equal(queries.length,1);
  assert.match(queries[0].sql,/^SELECT fingerprint/);
  assert.doesNotMatch(queries[0].sql,/UPDATE|INSERT|DELETE|ALTER|DROP/i);
  assert.equal(queries[0].params[0],"1593376338308612");
  assert.deepEqual(queries[0].params[1],monitor.FIELDS);
  assert.deepEqual(queries[0].params.slice(2),[48,15]);
  assert.equal(queries[0].sql.includes("meta_account_id=$1"),true);
});
test("report fails closed on missing SQL data and refuses unbounded scans",async()=>{
  const database={async query(){return{rows:[row("unknown_field")]};}};
  await assert.rejects(monitor.inspect({env:env(),database}),/Invalid/);
  await assert.rejects(monitor.inspect({env:env(),database,limit:1000}),/Invalid/);
  await assert.rejects(monitor.inspect({env:env(),database,lookbackHours:0}),/Invalid/);
  assert.throws(()=>monitor.summarize([{...row("security"),fingerprint:"invalid"}]),/Invalid/);
});
test("QA operator report cannot call Meta, WhatsApp sends or production connection pool",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "../scripts/qa/readOnlyOperationalWebhookQueue.cjs"),"utf8");
  assert.doesNotMatch(source,/require\("\.\.\/\.\.\/src\/db\/db"\)/);
  assert.doesNotMatch(source,/graph.facebook.com|sendWhatsApp|fetch\(/);
  assert.match(source,/ssl:\{rejectUnauthorized:true\}/);
});
