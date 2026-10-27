"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const repo=require("../src/db/whatsappCoexistenceOnboardingRepo");

const env=()=>({
  PR395_STAGING_MODE:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
  WHATSAPP_PHONE_NUMBER_ID:"111111111111111",
  WHATSAPP_WABA_ID:"222222222222222",
  PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:crypto.randomBytes(32).toString("base64"),
});
const scope={wabaId:"333333333333333",phoneNumberId:"444444444444444"};
const expiry=new Date(Date.now()+12*60*60*1000).toISOString();
function fakeDb(){
  const state={audit:null,credential:null,statements:[],rollbackCount:0,
    committed:false,failVault:false};
  const query=async(sql,args=[])=>{
    state.statements.push({sql,args});
    if(sql==="BEGIN")return {rowCount:0};
    if(sql==="COMMIT"){state.committed=true;return {rowCount:0};}
    if(sql==="ROLLBACK"){state.rollbackCount++;state.audit=null;state.credential=null;return {rowCount:0};}
    if(sql.includes("INSERT INTO whatsapp_coexistence_onboarding_attempts")){
      state.audit={id:21,status:"validated",waba_id:args[0],phone_number_id:args[1],
        token_expires_at:args[6]};
      return {rows:[state.audit],rowCount:1};
    }
    if(sql.includes("INSERT INTO whatsapp_coexistence_onboarding_credentials")){
      if(state.failVault)throw Error("synthetic SQL error");
      state.credential={
        attempt_id:args[0],waba_id:args[1],phone_number_id:args[2],
        key_version:args[3],nonce:args[4],ciphertext:args[5],
        auth_tag:args[6],token_expires_at:args[7]
      };
      return {rowCount:1};
    }
    if(sql.includes("FROM whatsapp_coexistence_onboarding_credentials c")){
      const at=Date.parse(args[2]);
      if(!state.committed || !state.credential ||
         state.credential.waba_id!==args[0] ||
         state.credential.phone_number_id!==args[1] ||
         Date.parse(state.credential.token_expires_at)<=at)return{rows:[]};
      return {rows:[state.credential]};
    }
    throw Error("Unexpected test query");
  };
  return {state,database:{connect:async()=>({query,release(){}}),query}};
}
test("verified signup token and audit are atomic; load only with exact sender scope",async()=>{
  const source=env(),db=fakeDb();
  const accessToken="test-validated-opaque-system-user-access-token";
  const record=await repo.recordValidatedWithCredential({
    ...scope,accessToken,tokenExpiresAt:expiry,startedBy:"qa-admin",
    coexistenceReady:true,
  },{database:db.database,env:source});
  assert.equal(record.id,21);
  assert.equal(db.state.committed,true);
  assert.equal(db.state.credential.waba_id,scope.wabaId);
  assert.equal(db.state.credential.phone_number_id,scope.phoneNumberId);
  assert.equal(JSON.stringify(db.state.audit).includes(accessToken),false);
  const inserts=db.state.statements.filter(x=>x.sql.startsWith("INSERT"));
  assert.equal(JSON.stringify(inserts).includes(accessToken),false);
  const credential=await repo.loadValidatedCredentialForSetup(scope,{database:db.database,env:source});
  assert.equal(credential.accessToken,accessToken);
  assert.equal(credential.wabaId,scope.wabaId);
  await assert.rejects(repo.loadValidatedCredentialForSetup({
    ...scope,phoneNumberId:"555555555555555"
  },{database:db.database,env:source}),/No valid unexpired/);
  await assert.rejects(repo.loadValidatedCredentialForSetup(scope,{
    database:db.database,env:source,now:new Date(Date.now()+48*60*60*1000)
  }),/No valid unexpired/);
  await assert.rejects(repo.loadValidatedCredentialForSetup(scope,{
    database:db.database,env:{...source,PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:crypto.randomBytes(32).toString("base64")}
  }),/auth|authenticate|Unsupported state/i);
});
test("SQL vault failure rolls back the validated attempt and never claims success",async()=>{
  const db=fakeDb();db.state.failVault=true;
  await assert.rejects(repo.recordValidatedWithCredential({
    ...scope,accessToken:"test-opaque-system-user-access-token",tokenExpiresAt:expiry
  },{database:db.database,env:env()}),/could not be saved securely/);
  assert.equal(db.state.rollbackCount,1);
  assert.equal(db.state.committed,false);
  assert.equal(db.state.audit,null);
});
test("vault refuses primary account, expired credential and missing independent encryption key",async()=>{
  const source=env(),db=fakeDb();
  for(const unsafe of [
    {env:{...source,WHATSAPP_WABA_ID:scope.wabaId},opts:{...scope,tokenExpiresAt:expiry}},
    {env:{...source,WHATSAPP_PHONE_NUMBER_ID:scope.phoneNumberId},opts:{...scope,tokenExpiresAt:expiry}},
    {env:source,opts:{...scope,tokenExpiresAt:new Date(Date.now()-1000).toISOString()}},
    {env:{...source,PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:""},opts:{...scope,tokenExpiresAt:expiry}},
  ]){
    await assert.rejects(repo.recordValidatedWithCredential({
      ...unsafe.opts,accessToken:"test-opaque-system-user-access-token"
    },{database:db.database,env:unsafe.env}));
  }
  assert.equal(db.state.statements.length,0);
});
