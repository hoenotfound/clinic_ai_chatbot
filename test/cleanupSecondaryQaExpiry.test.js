"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const retention=require("../scripts/qa/cleanupSecondaryQaExpiry.cjs");
function env(patch={}) {
  return {
    WHATSAPP_SECONDARY_QA_RETENTION_ENABLED:"true",
    WHATSAPP_SECONDARY_QA_RETENTION_PROJECT_ID:"wandering-dream-82267835",
    WHATSAPP_SECONDARY_QA_RETENTION_BRANCH_ID:"br-late-sky-ao8xggam",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://qa:private@ep-isolated.ap-southeast-1.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-isolated.ap-southeast-1.aws.neon.tech",
    DATABASE_URL:"postgresql://prod:private@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
    ...patch
  };
}
function db({identity=true,deleted=2,fail=false}={}) {
  const queries=[];let released=0;
  return {
    queries,get released(){return released;},
    async connect(){return{
      async query(sql,params){
        queries.push({sql,params});
        if(fail && sql===retention.SQL.prune)throw Error("Database unavailable");
        if(sql===retention.SQL.identity)return{rows:[identity
          ?{database_name:"neondb",target_table:retention.TABLE,migration:104}
          :{database_name:"neondb",target_table:retention.TABLE,migration:103}]};
        if(sql===retention.SQL.prune)return{rows:[{deleted}]};
        return{rows:[]};
      },release(){released++;}
    };}
  };
}
test("QA expiry requires independent pinned Neon and remains default OFF",()=>{
  assert.throws(()=>retention.retentionConfig(env({
    WHATSAPP_SECONDARY_QA_RETENTION_ENABLED:"false"})),/disabled/);
  assert.throws(()=>retention.retentionConfig(env({
    WHATSAPP_SECONDARY_QA_RETENTION_PROJECT_ID:"steep-forest-44509907"})),/project/);
  assert.throws(()=>retention.retentionConfig(env({
    WHATSAPP_SECONDARY_QA_RETENTION_BRANCH_ID:"br-foreign"})),/project/);
  assert.throws(()=>retention.retentionConfig(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:env().DATABASE_URL,
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-prod.ap-southeast-1.aws.neon.tech"})),
    /Refusing/);
  assert.throws(()=>retention.retentionConfig(env({
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"different.neon.tech"})),/Refusing/);
});
test("bounded cleanup uses single transactional QA-only DELETE with no ciphertext output",async()=>{
  const database=db();
  const result=await retention.cleanupExpired({env:env(),database});
  assert.deepEqual(result,{qaOnly:true,deleted:2,maxBatch:100,hasMorePossible:false});
  assert.deepEqual(database.queries.map(q=>q.sql).filter(x=>x==="BEGIN"||x==="COMMIT"),
    ["BEGIN","COMMIT"]);
  assert.match(retention.SQL.prune,/LIMIT \$1 FOR UPDATE SKIP LOCKED/);
  assert.match(retention.SQL.prune,/WHERE expires_at < NOW\(\)/);
  assert.doesNotMatch(retention.SQL.prune,/RETURNING (ciphertext|\*)/i);
  assert.deepEqual(database.queries.find(q=>q.sql===retention.SQL.prune).params,[100]);
  assert.equal(database.released,1);
});
test("schema drift and DB failures rollback rather than succeeding silently",async()=>{
  for(const options of [{identity:false},{fail:true}]){
    const database=db(options);
    await assert.rejects(retention.cleanupExpired({env:env(),database}));
    assert.equal(database.queries.at(-1).sql,"ROLLBACK");
    assert.equal(database.released,1);
  }
});
test("bounded cleanup never deletes more than 250 per pass",async()=>{
  const database=db({deleted:250});
  const result=await retention.cleanupExpired({
    env:env({WHATSAPP_SECONDARY_QA_RETENTION_BATCH_SIZE:"5000"}),database});
  assert.deepEqual([result.maxBatch,result.deleted,result.hasMorePossible],[250,250,true]);
  assert.deepEqual(database.queries.find(q=>q.sql===retention.SQL.prune).params,[250]);
});
