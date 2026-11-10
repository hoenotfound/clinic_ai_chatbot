"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const whatsapp=require("../src/services/whatsappService");
const guard=require("../src/services/whatsappZeroCostGuard");
const cancellation=require("../src/services/aiReplyCancellationService");
const coexistence=require("../src/services/whatsappCoexistenceService");
const { conversationKeyForSender }=require("../src/services/whatsappSenderRouting");

test("sender-scoped cancellation keys preserve BSUID without stripping digits",()=>{
  const id="MY.Ab12CD34";
  assert.equal(conversationKeyForSender("neutro_secondary",id),
    "whatsapp:neutro_secondary:"+id);
  assert.equal(cancellation.keyForContact({channel:"whatsapp",whatsapp_number:"60123456789",
    whatsapp_user_id:id,whatsapp_sender_key:"neutro_secondary"}),
    "whatsapp:neutro_secondary:"+id);
  assert.notEqual(conversationKeyForSender("primary",id),
    conversationKeyForSender("neutro_secondary",id));
});

test("Coexistence staff echo blocks both telephone and scoped-identity AI turns",()=>{
  const snapshot={};
  for(const name of ["WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED",
    "WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED","WHATSAPP_SECONDARY_PHONE_NUMBER_ID",
    "WHATSAPP_SECONDARY_WABA_ID","WHATSAPP_SECONDARY_SENDER_KEY",
    "WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_WABA_ID"]){
    snapshot[name]=process.env[name];
  }
  Object.assign(process.env,{
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
    WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
    WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
    WHATSAPP_WABA_ID:"1593376338308612",
  });
  const id="MY.Ab12CD34",phone="60123456789";
  const echo={id:"wamid.bsuid-staff-test",type:"text",to:phone,toUserId:id,
    businessPhoneNumberId:"1318355951360575",
    businessAccountId:"1852014482431209"};
  const addressKey=conversationKeyForSender("neutro_secondary",id);
  const phoneKey=conversationKeyForSender("neutro_secondary",phone);
  try{
    assert.equal(coexistence.beginPendingAiForEcho(echo),true);
    assert.equal(cancellation.hasPendingEcho(addressKey),true);
    assert.equal(cancellation.hasPendingEcho(phoneKey),true);
    coexistence.releasePendingAiForEcho(echo);
    assert.equal(cancellation.hasPendingEcho(addressKey),false);
    assert.equal(cancellation.hasPendingEcho(phoneKey),false);
  }finally{
    for(const [name,value] of Object.entries(snapshot)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  }
});

test("primary Cloud API text uses recipient for BSUID and to for normal phone",async()=>{
  const originalPerform=guard.perform,originalFetch=global.fetch;
  const before={WHATSAPP_PHONE_NUMBER_ID:process.env.WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_TOKEN:process.env.WHATSAPP_TOKEN};
  const calls=[];
  try{
    process.env.WHATSAPP_PHONE_NUMBER_ID="100000000000001";
    process.env.WHATSAPP_TOKEN="test-token";
    guard.perform=async(_to,operation)=>operation();
    global.fetch=async(_url,opts)=>{
      calls.push(JSON.parse(opts.body));
      return {ok:true,status:200,json:async()=>({messages:[{id:"wamid.test-accepted"}]})};
    };
    const bsuid=await whatsapp.sendMessage("MY.Ab12CD34","Hello");
    const phone=await whatsapp.sendMessage("60123456789","Hello");
    assert.equal(bsuid.success,true);
    assert.equal(phone.success,true);
    assert.deepEqual({to:calls[0].to,recipient:calls[0].recipient},
      {to:undefined,recipient:"MY.Ab12CD34"});
    assert.deepEqual({to:calls[1].to,recipient:calls[1].recipient},
      {to:"60123456789",recipient:undefined});
  }finally{
    guard.perform=originalPerform;global.fetch=originalFetch;
    for(const [name,value] of Object.entries(before)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  }
});

test("primary billing routes BSUID separately while retaining indexed phone SQL",()=>{
  const id="MY.Ab12CD34";
  assert.match(guard.sqlForCustomerAddress(guard.SCOPED_VERIFIED_WINDOW_SQL,id),
    /c\\.whatsapp_user_id=\\$3/);
  assert.match(guard.sqlForCustomerAddress(guard.SCOPED_CTWA_FIRST_REPLY_SQL,id),
    /c\\.whatsapp_user_id=\\$2/);
  assert.match(guard.sqlForCustomerAddress(guard.SCOPED_SESSION_WINDOW_SQL,id),
    /c\\.whatsapp_user_id=\\$3/);
  assert.doesNotMatch(guard.SCOPED_VERIFIED_WINDOW_SQL,/c\\.whatsapp_user_id/);
  assert.match(guard.SCOPED_VERIFIED_WINDOW_SQL,/regexp_replace/);
});
