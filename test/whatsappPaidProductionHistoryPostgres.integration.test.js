"use strict";
// Disposable-schema integration. Never runs against user/production Neon.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {Client}=require("pg");
const {runMigrations}=require("../src/db/migrationRunner");
const receiver=require("../src/services/whatsappPaidProductionHistoryReceiver");
const history=require("../src/services/whatsappCoexistenceHistoryService");

const url=process.env.TEST_DATABASE_URL;
function localOnly(){
  const u=new URL(url);
  if(!["localhost","127.0.0.1"].includes(u.hostname))throw Error("Refusing nonlocal PostgreSQL");
}
const secret="synthetic-signed-production-history-test-secret";
const env={
  PR395_STAGING_MODE:"false",WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_WABA_ID:"1593376338308612",WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
};
const data={
  object:"whatsapp_business_account",entry:[{
    id:env.WHATSAPP_SECONDARY_WABA_ID,changes:[{field:"history",value:{
      metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
      history:[{threads:[{id:"60126662222",messages:[{
        id:"wamid.neutro-secondary-history-001",from:"60126662222",
        type:"text",timestamp:String(Math.floor(Date.now()/1000)-3600),
        text:{body:"Synthetic old conversation"}
      }]}]}]
    }}]
  }]
};
function req(body=data){
  const raw=Buffer.from(JSON.stringify(body));
  return {body,whatsappSignedRawBody:raw,
    headers:{"x-hub-signature-256":"sha256="+
      crypto.createHmac("sha256",secret).update(raw).digest("hex")}};
}
function res(){
  return{headersSent:false,statusCode:0,sendStatus(code){
    this.statusCode=code;this.headersSent=true;return this;
  }};
}
test("signed secondary-only production route stages durable original history exactly once; no primary contact changes",{
  skip:!url,timeout:120000,
},async()=>{
  localOnly();
  const client=new Client({connectionString:url});
  const schema="paid_history_"+process.pid+"_"+Date.now();
  await client.connect();
  try{
    await client.query("CREATE SCHEMA "+schema);
    await client.query("SET search_path TO "+schema);
    const database={
      query:(...args)=>client.query(...args),
      connect:async()=>{
        const c=new Client({connectionString:url});await c.connect();
        await c.query("SET search_path TO "+schema);
        return{query:(...args)=>c.query(...args),release:()=>c.end()};
      }
    };
    await runMigrations(database,{quiet:true});
    await client.query(
      "INSERT INTO whatsapp_sender_accounts(sender_key,meta_phone_number_id,"+
      "meta_account_id,display_name,state,coexistence_enabled) VALUES "+
      "('neutro','1408739622311791','1593376338308612','Neutro','active',FALSE),"+
      "('neutro_secondary','333333333333333','222222222222222','Second','active',TRUE)"
    );
    let primary=0;
    const opts={
      env,
      stageHistory:(body,options)=>history.acceptPassiveSync(body,{...options,database}),
      dispatchPrimary:async()=>{primary++;throw Error("No primary handler for secondary only");}
    };
    for(let i=0;i<2;i++){
      const response=res();
      await receiver.dispatch(req(),response,()=>{throw Error("No primary");},opts);
      assert.equal(response.statusCode,200);
    }
    assert.equal(primary,0);
    const jobs=(await client.query(
      "SELECT j.status,j.event_field,s.sender_key,j.payload IS NOT NULL AS payload_kept "+
      "FROM whatsapp_sender_coexistence_import_jobs j "+
      "JOIN whatsapp_sender_accounts s ON s.id=j.sender_id"
    )).rows;
    assert.deepEqual(jobs,[{
      status:"pending",event_field:"history",sender_key:"neutro_secondary",payload_kept:true
    }]);
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM messages")).rows[0].n,0);
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM contacts")).rows[0].n,0);
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_billing_attempts")).rows[0].n,0);
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_sync_events")).rows[0].n,0);
    const verified=(await client.query(
      "SELECT sender_key,state,coexistence_enabled FROM whatsapp_sender_accounts ORDER BY sender_key"
    )).rows;
    assert.deepEqual(verified,[
      {sender_key:"neutro",state:"active",coexistence_enabled:false},
      {sender_key:"neutro_secondary",state:"active",coexistence_enabled:true},
    ]);
    // An operator offboarding the second phone prevents further history
    // acceptance without disturbing Neutro's primary sender.
    await client.query("UPDATE whatsapp_sender_accounts SET state='disabled' WHERE sender_key='neutro_secondary'");
    const second={...data,entry:[{...data.entry[0],changes:[
      {...data.entry[0].changes[0],value:{
        ...data.entry[0].changes[0].value,
        history:[{threads:[{id:"60125551111",messages:[]}]}]
      }}
    ]}]};
    await assert.rejects(
      receiver.dispatch(req(second),res(),()=>{throw Error("No primary");},opts),
      /Coexistence importer sender not verified/
    );
    assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs")).rows[0].n,1);
    assert.equal((await client.query("SELECT state FROM whatsapp_sender_accounts WHERE sender_key='neutro'")).rows[0].state,"active");
  }finally{
    await client.query("SET search_path TO public").catch(()=>{});
    await client.query("DROP SCHEMA IF EXISTS "+schema+" CASCADE").catch(()=>{});
    await client.end();
  }
});
