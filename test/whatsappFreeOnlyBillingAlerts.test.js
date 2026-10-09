const test=require("node:test");
const assert=require("node:assert/strict");
const billing=require("../src/services/whatsappFreeOnlyBillingAlerts");
const clinicConfig=require("../src/config/clinicConfig");

function setup(t,enabled=true){
  const original=clinicConfig.automatedFollowUp;
  const phone=process.env.WHATSAPP_PHONE_NUMBER_ID;
  clinicConfig.automatedFollowUp={...original,whatsappFreeOnly:{
    enabled,activatedAt:"2026-10-09T00:00:00.000Z"
  }};
  process.env.WHATSAPP_PHONE_NUMBER_ID="clinic-phone-1";
  t.after(()=>{clinicConfig.automatedFollowUp=original;
    if(phone===undefined)delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID=phone;});
}

const env={TELEGRAM_ALERTS_ENABLED:"true",TELEGRAM_BOT_TOKEN:"token",TELEGRAM_CHAT_ID:"chat"};
test("billable callbacks trigger one durable Telegram send and mark delivery",async t=>{
  setup(t);
  let claims=0,posted=0,completed=0;
  const database={async query(sql,params){
    if(sql.includes("UPDATE whatsapp_free_only_billing_alerts alerts")){
      claims++;assert.equal(params[0],"clinic-phone-1");
      return {rows:[{wamid:"wamid.paid",attempts:1}]};
    }
    if(sql.includes("SET sent_at=now()")){completed++;return {rows:[]};}
    throw new Error("Unexpected billing alert query");
  }};
  const result=await billing.flush({database,env,send:async message=>{
    assert.match(message.text,/BILLING ALARM/);posted++;return {ok:true};
  }});
  assert.equal(result,1);
  assert.equal(claims,1);
  assert.equal(posted,1);
  assert.equal(completed,1);
});

test("failed Telegram notification stays queued for another recovery attempt",async t=>{
  setup(t);
  let retried=0;
  const database={async query(sql){
    if(sql.includes("UPDATE whatsapp_free_only_billing_alerts alerts"))
      return {rows:[{wamid:"wamid.paid",attempts:2}]};
    if(sql.includes("last_error=$2")){retried++;return {rows:[]};}
    throw new Error("Unexpected query");
  }};
  const original=console.error;
  console.error=()=>{};
  t.after(()=>{console.error=original});
  const result=await billing.flush({database,env,send:async()=>{throw Error("Telegram offline");}});
  assert.equal(result,0);
  assert.equal(retried,1);
});

test("when free-only is off, billing alert worker does not send",async t=>{
  setup(t,false);
  const database={query(){throw Error("No database required");}};
  assert.equal(await billing.flush({database,env,send:()=>{throw Error("should not send")}}),0);
});
