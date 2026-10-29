"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const receiver=require("../src/services/whatsappPaidProductionHistoryReceiver");
const secret="test-meta-secret-for-signed-history-receiver";
const env=Object.freeze({
  PR395_STAGING_MODE:"false",
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
  WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"333333333333333",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
});
const change=(field,phone="333333333333333")=>({
  field,value:{metadata:{phone_number_id:phone},history:[]}
});
const body=(...entries)=>({object:"whatsapp_business_account",entry:entries});
const entry=(id,...changes)=>({id,changes});
function req(packet,opts={}){
  const raw=Buffer.from(JSON.stringify(packet));
  return {body:packet,whatsappSignedRawBody:raw,
    headers:{"x-hub-signature-256":"sha256="+
      crypto.createHmac("sha256",secret).update(raw).digest("hex")},...opts};
}
function res(){
  return {headersSent:false,statusCode:0,
    sendStatus(v){this.statusCode=v;this.headersSent=true;return this;}};
}

test("disabled receiver cannot stage any history or alter default primary router",async()=>{
  assert.equal(receiver.configured({}),false);
  assert.throws(()=>receiver.assertConfig({}),/disabled/);
  assert.equal(receiver.configured({...env,WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false"}),false);
});

test("new signed secondary messages can be received without authorizing old-chat history",async()=>{
  const liveEnv={...env,
    WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"false",
    WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"false",
    WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"false",
    WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
    WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
    WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
    WHATSAPP_SECONDARY_TOKEN:""
  };
  assert.equal(receiver.liveConfigured(liveEnv),true);
  assert.equal(receiver.configured(liveEnv),false);
  assert.equal(receiver.assertLiveConfig(liveEnv).secondaryPhone,
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  let routed=0;
  const response=res();
  await receiver.dispatch(req(body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
    change("messages")))),response,(request,s)=>{
      routed++;
      assert.equal(request.body.entry[0].id,env.WHATSAPP_SECONDARY_WABA_ID);
      return s.sendStatus(200);
    },{
      env:liveEnv,
      stageHistory:async()=>{throw Error("History must remain off");},
      dispatchPrimary:async()=>{throw Error("Live event must not be quarantined");}
    });
  assert.equal(response.statusCode,200);
  assert.equal(routed,1);
  await assert.rejects(receiver.dispatch(req(body(entry(
    env.WHATSAPP_SECONDARY_WABA_ID,change("history")))),
    res(),()=>{routed++;},{env:liveEnv,stageHistory:async()=>{throw Error("No staging");}}),
    /Secondary history receiver not approved/);
  assert.equal(routed,1);
  for(const [key,value] of [
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID","123"],
    ["WHATSAPP_SINGLE_SENDER_STRICT_METADATA","false"],
    ["WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED","false"]
  ]){
    assert.throws(()=>receiver.assertLiveConfig({...liveEnv,[key]:value}),/Unverified/);
  }
  assert.throws(()=>receiver.assertLiveConfig({
    ...liveEnv,WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"false"
  }),/disabled/);
});
test("production receiver validates exact isolated and approved sender, with all sending off",()=>{
  assert.equal(receiver.assertConfig(env).secondaryPhone,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  const blocked=[
    ["WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED","false"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED","false"],
    ["PR395_STAGING_MODE","true"],
    ["WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED","true"],
    ["WHATSAPP_WABA_ID",env.WHATSAPP_SECONDARY_WABA_ID],
    ["WHATSAPP_PHONE_NUMBER_ID",env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID],
    ["WHATSAPP_SECONDARY_WABA_ID",env.WHATSAPP_WABA_ID],
    ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID",""],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID",""],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60129998888"],
    ["WHATSAPP_SECONDARY_SENDER_KEY","coexistence_qa"],
    ["WHATSAPP_PRIMARY_SENDER_KEY","coexistence_qa"],
    ["WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED","false"],
    ["WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED","false"],
    ["WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","true"],
    ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"],
    ["WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED","true"],
  ];
  for(const [key,value] of blocked){
    assert.throws(()=>receiver.assertConfig({...env,[key]:value}),/Unverified/,
      "must reject "+key);
  }
});
test("exact secondary history is isolated, no user message or primary route runs",async()=>{
  const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
    change("history"),change("smb_app_state_sync")));
  const accepted=[];let primary=0;const result=res();
  await receiver.dispatch(req(packet),result,()=>{primary++;},{
    env,dispatchPrimary:()=>{primary++;throw Error("Primary must not run");},
    stageHistory:async(b,{env:pin})=>{
      assert.equal(pin,env);
      accepted.push(...b.entry[0].changes.map(c=>c.field));
      return{enabled:true,staged:2};
    }
  });
  assert.equal(result.statusCode,200);
  assert.equal(primary,0);
  assert.deepEqual(accepted,["history","smb_app_state_sync"]);
});
test("duplicate/replay history with zero new jobs still gets 200",async()=>{
  const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history")));
  let calls=0;for(let i=0;i<2;i++){
    const response=res();
    await receiver.dispatch(req(packet),response,()=>{throw Error("primary");},{
      env,stageHistory:async()=>({enabled:true,staged:calls++===0?1:0})
    });
    assert.equal(response.statusCode,200);
  }
  assert.equal(calls,2);
});
test("invalid signature or raw-body mismatch never touches DB or primary",async()=>{
  const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history")));
  let calls=0;
  const broken=[
    req(packet,{whatsappSignedRawBody:null}),
    req(packet,{headers:{"x-hub-signature-256":"sha256="+"0".repeat(64)}}),
    req(packet,{headers:{"x-hub-signature-256":"sha256=BAD"}}),
    req(packet,{whatsappSignedRawBody:Buffer.from("{}")})
  ];
  for(const request of broken){
    await assert.rejects(receiver.dispatch(request,res(),()=>{calls++;},{
      env,stageHistory:async()=>{calls++;}
    }),/signed Meta/);
  }
  assert.equal(calls,0);
});
test("foreign history, wrong phone, malformed batch, and mixed wrong-phone abort before ANY DB staging",async()=>{
  const cases=[
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history","1408739622311791"))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history",null))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history","888888888888888"))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,{field:"history",value:null})),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history")),
      entry(env.WHATSAPP_SECONDARY_WABA_ID,change("smb_app_state_sync","000"))),
    body(...Array.from({length:101},()=>entry("9999999",change("history")))),
  ];
  let persisted=0;
  for(const packet of cases){
    await assert.rejects(receiver.dispatch(req(packet),res(),()=>{},{
      env,stageHistory:async()=>{persisted++;}
    }),/sender identity mismatch|Malformed|Invalid|excessive/);
  }
  assert.equal(persisted,0);
});
test("mixed primary and secondary stages history BEFORE unchanged primary handler ACK",async()=>{
  const packet=body(
    entry(env.WHATSAPP_WABA_ID,change("messages",env.WHATSAPP_PHONE_NUMBER_ID)),
    entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history"))
  );
  const order=[],response=res();
  await receiver.dispatch(req(packet),response,()=>{throw Error("unexpected");},{
    env,
    stageHistory:async b=>{order.push("stage");
      assert.equal(b.entry[0].id,env.WHATSAPP_SECONDARY_WABA_ID);
      return{enabled:true,staged:1};},
    dispatchPrimary:async(r,s)=>{
      order.push("primary");
      assert.equal(r.body.entry.length,1);
      assert.equal(r.body.entry[0].id,env.WHATSAPP_WABA_ID);
      s.sendStatus(200);
    }
  });
  assert.deepEqual(order,["stage","primary"]);
  assert.equal(response.statusCode,200);
});
test("database failure or disabled importer cannot return successful ACK or dispatch primary",async()=>{
  const packet=body(entry(env.WHATSAPP_WABA_ID,change("messages",env.WHATSAPP_PHONE_NUMBER_ID)),
    entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history")));
  let primary=0;
  for(const stageHistory of [
    async()=>{throw Error("synthetic DB outage");},
    async()=>({enabled:false,staged:0}),
    async()=>undefined,
  ]){
    const response=res();
    await assert.rejects(receiver.dispatch(req(packet),response,()=>{},{
      env,stageHistory,dispatchPrimary:()=>{primary++;}
    }),/outage|durably staged/);
    assert.equal(response.headersSent,false);
  }
  assert.equal(primary,0);
});
test("signed secondary live messages and Business App echoes route through existing Inbox handler",async()=>{
  for(const field of ["messages","smb_message_echoes"]){
    const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change(field)));
    let routed=0;const response=res();
    await receiver.dispatch(req(packet),response,(request,s)=>{
      routed++;
      assert.equal(request.body.entry.length,1);
      assert.equal(request.body.entry[0].id,env.WHATSAPP_SECONDARY_WABA_ID);
      assert.equal(request.body.entry[0].changes[0].field,field);
      return s.sendStatus(200);
    },{
      env,stageHistory:async()=>{throw Error("No passive history in live event");},
      dispatchPrimary:()=>{throw Error("Paid primary router must not reject secondary live");}
    });
    assert.equal(response.statusCode,200);
    assert.equal(routed,1);
  }
});
test("mixed signed history plus secondary live is staged before Inbox ACK",async()=>{
  const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
    change("history"),change("messages")));
  const order=[];const response=res();
  await receiver.dispatch(req(packet),response,(request,s)=>{
    order.push("inbox");
    assert.deepEqual(request.body.entry[0].changes.map(c=>c.field),["messages"]);
    return s.sendStatus(200);
  },{
    env,stageHistory:async request=>{
      order.push("stage");
      assert.deepEqual(request.entry[0].changes.map(c=>c.field),["history"]);
      return{enabled:true,staged:1};
    },dispatchPrimary:()=>{throw Error("Incorrect default route");}
  });
  assert.deepEqual(order,["stage","inbox"]);
  assert.equal(response.statusCode,200);
});
test("mixed primary and secondary live forwards only the two verified senders",async()=>{
  const packet=body(
    entry(env.WHATSAPP_WABA_ID,change("messages",env.WHATSAPP_PHONE_NUMBER_ID)),
    entry(env.WHATSAPP_SECONDARY_WABA_ID,change("messages"))
  );
  let seen=0;const response=res();
  await receiver.dispatch(req(packet),response,(request,s)=>{
    seen++;
    assert.deepEqual(request.body.entry.map(e=>e.id),
      [env.WHATSAPP_WABA_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
    return s.sendStatus(200);
  },{env,dispatchPrimary:()=>{throw Error("Wrong handler");}});
  assert.equal(response.statusCode,200);
  assert.equal(seen,1);
});
test("signed secondary account disconnect requires exact E164 and uses existing lifecycle handler",async()=>{
  const life=number=>({field:"account_update",value:{
    phone_number:number,event:"PARTNER_REMOVED"
  }});
  let seen=0;const good=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,life("+60174831336")));
  const response=res();
  await receiver.dispatch(req(good),response,(request,s)=>{
    seen++;
    assert.equal(request.body.entry[0].changes[0].value.event,"PARTNER_REMOVED");
    return s.sendStatus(200);
  },{env,dispatchPrimary:()=>{throw Error("Wrong lifecycle handler");}});
  assert.equal(response.statusCode,200);
  assert.equal(seen,1);
  for(const number of ["+601130535053","+60178888888"]){
    await assert.rejects(receiver.dispatch(
      req(body(entry(env.WHATSAPP_SECONDARY_WABA_ID,life(number)))),
      res(),()=>{seen++;},{env}),/Signed live sender identity mismatch/);
  }
  assert.equal(seen,1);
});
test("wrong live phone and foreign mixed batches fail closed without history staging",async()=>{
  const cases=[
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
      change("messages",env.WHATSAPP_PHONE_NUMBER_ID))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("messages")),
      entry("99999999999",change("messages",env.WHATSAPP_PHONE_NUMBER_ID))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
      change("history"),change("messages")),
      entry("99999999999",change("history",env.WHATSAPP_PHONE_NUMBER_ID)))
  ];
  let sideEffects=0;
  for(const packet of cases){
    await assert.rejects(receiver.dispatch(req(packet),res(),()=>{
      sideEffects++;
    },{env,stageHistory:async()=>{sideEffects++;return{enabled:true,staged:1};},
       dispatchPrimary:async()=>{sideEffects++;}}),
      /Signed live sender identity mismatch|Unsafe mixed WhatsApp live batch/);
  }
  assert.equal(sideEffects,0);
});
test("foreign and unsupported secondary notifications still go to paid router; no false history ACK",async()=>{
  const packets=[
    body(entry("99999999999",change("history",env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID))),
    body(entry(env.WHATSAPP_SECONDARY_WABA_ID,change("unsupported")))
  ];
  let staged=0,primary=0;
  for(const packet of packets){
    const response=res();
    await receiver.dispatch(req(packet),response,()=>{},{
      env,stageHistory:async()=>{staged++;},
      dispatchPrimary:async()=>{primary++;response.sendStatus(503);}
    });
    assert.equal(response.statusCode,503);
  }
  assert.equal(staged,0);
  assert.equal(primary,2);
});


test("account-level lifecycle without E164 is accepted only for pinned WABA and known events",async()=>{
  const cases=[
    {event:"PARTNER_REMOVED"},
    {event:"ACCOUNT_OFFBOARDED"},
    {event:"ACCOUNT_RECONNECTED"},
  ];
  for(const value of cases){
    const packet=body(entry(env.WHATSAPP_SECONDARY_WABA_ID,
      {field:"account_update",value}));
    const response=res();
    let received=0;
    await receiver.dispatch(req(packet),response,(request,s)=>{
      received++;
      assert.equal(request.body.entry[0].id,env.WHATSAPP_SECONDARY_WABA_ID);
      assert.equal(request.body.entry[0].changes[0].value.event,value.event);
      return s.sendStatus(200);
    },{env});
    assert.equal(response.statusCode,200);
    assert.equal(received,1);
  }
  const denied=[
    {event:"PARTNER_REMOVED",phone_number:"+601130535053"},
    {event:"PARTNER_REMOVED",phone_number:null},
    {event:"PARTNER_REMOVED",metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID}},
    {event:"UNRECOGNIZED_EVENT"},
  ];
  for(const value of denied){
    let reached=0;
    await assert.rejects(receiver.dispatch(req(body(entry(
      env.WHATSAPP_SECONDARY_WABA_ID,
      {field:"account_update",value}
    ))),res(),()=>{reached++;},{env}),/Signed live sender identity mismatch/);
    assert.equal(reached,0);
  }
  const wrongWaba=body(entry("999999999999999",{
    field:"account_update",value:{event:"PARTNER_REMOVED"}
  }));
  const response=res();let accepted=0;
  await receiver.dispatch(req(wrongWaba),response,()=>{accepted++;},{
    env,dispatchPrimary:(r,s)=>s.sendStatus(503)
  });
  assert.equal(response.statusCode,503);
  assert.equal(accepted,0);
});

test("live messages and staff echoes still require exact secondary phone metadata",async()=>{
  const liveEnv={...env,WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"false",
    WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
    WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
    WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true"};
  for(const field of ["messages","smb_message_echoes"]){
    for(const value of [{messages:[]},{metadata:{phone_number_id:env.WHATSAPP_PHONE_NUMBER_ID}}]){
      let forwarded=0;
      await assert.rejects(receiver.dispatch(req(body(entry(
        env.WHATSAPP_SECONDARY_WABA_ID,{field,value}
      ))),res(),()=>{forwarded++;},{env:liveEnv}),
      /Signed live sender identity mismatch/);
      assert.equal(forwarded,0);
    }
  }
});

test("only explicit, fully guarded staff-text cutover can use signed paid LIVE receiver", async () => {
  const live={...env,
    WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
    WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
    WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
    WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED:"true",
    WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
    WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
    WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
    WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
    WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
    WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
    WHATSAPP_SECONDARY_TOKEN:"separate-synthetic-token"
  };
  assert.equal(receiver.assertLiveConfig(live).secondaryPhone,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  let routed=0;
  const result=res();
  await receiver.dispatch(req(body(
    entry(env.WHATSAPP_WABA_ID,change("messages",env.WHATSAPP_PHONE_NUMBER_ID)),
    entry(env.WHATSAPP_SECONDARY_WABA_ID,change("messages"))
  )),result,(request,response)=>{
    routed++;
    assert.deepEqual(request.body.entry.map(e=>e.id), [
      env.WHATSAPP_WABA_ID,env.WHATSAPP_SECONDARY_WABA_ID
    ]);
    return response.sendStatus(200);
  },{env:live,dispatchPrimary:()=>{throw Error("Wrong router");}});
  assert.equal(result.statusCode,200);
  assert.equal(routed,1);
  // The history receiver remains OFF; a late old-history callback must 503
  // (not acknowledge as delivered or secretly import anything).
  await assert.rejects(receiver.dispatch(req(body(
    entry(env.WHATSAPP_SECONDARY_WABA_ID,change("history"))
  )),res(),()=>{}, {env:live,stageHistory:async()=>{throw Error("Must not stage");}}),
  /Secondary history receiver not approved/);
  // The old import/history receiver cannot ever be armed for sending.
  assert.throws(()=>receiver.assertConfig({...env,
    WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED:"true"
  }),/Unverified/);
  for(const [key,value] of [
    ["WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
    ["WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED","false"],
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","false"],
    ["WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED","false"],
    ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED","false"],
    ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
    ["WHATSAPP_SECONDARY_TOKEN",""],
    ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","true"],
    ["WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED","true"],
    ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"],
    ["PR395_STAGING_MODE","true"],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60123333333"],
  ]){
    assert.throws(()=>receiver.assertLiveConfig({...live,[key]:value}),
      /Unverified|disabled/,key+" must fail closed");
  }
});
