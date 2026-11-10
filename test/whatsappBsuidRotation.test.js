"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {parseIncomingMessages}=require("../src/services/whatsappService");
const {createInboundMessageClaimService}=require("../src/services/inboundMessageClaimService");

function callback(messages){
  return {object:"whatsapp_business_account",entry:[{
    id:"1852014482431209",changes:[{field:"messages",value:{
      metadata:{phone_number_id:"1318355951360575"},messages,
    }}],
  }]};
}
function rotation(type="user_changed_user_id",withPhone=false){
  return {
    id:"wamid.rotation.123",type:"system",
    system:{type,previous_user_id:"MY.OldID123",user_id:"MY.NewID456",
      ...(withPhone?{wa_id:"60123456789"}:{})},
  };
}
test("Meta system identity-only webhook is captured even without from",()=>{
  const [event]=parseIncomingMessages(callback([rotation()]));
  assert.equal(event.identityRotationOnly,true);
  assert.equal(event.from,"MY.OldID123");
  assert.equal(event.previousUserId,"MY.OldID123");
  assert.equal(event.newUserId,"MY.NewID456");
  assert.equal(event.newPhone,undefined);
  assert.equal(event.businessPhoneNumberId,"1318355951360575");
  assert.equal(event.businessAccountId,"1852014482431209");
  assert.equal(event.text,undefined);
});
test("Meta user_changed_number provides a signed new phone; generic system does not start a chat",()=>{
  const [event]=parseIncomingMessages(callback([rotation("user_changed_number",true)]));
  assert.equal(event.newPhone,"60123456789");
  assert.deepEqual(parseIncomingMessages(callback([
    {id:"wamid.generic",type:"system",system:{type:"other"}},
  ])),[]);
});
test("rotation cannot create customer messages, processing jobs or AI tasks",async()=>{
  const before=process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
  process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED="true";
  const calls=[];
  const senderIdentity={async rotateSenderUserId(identity){
    calls.push(identity);
    return {updated:true,contactId:77};
  }};
  const unsafe={getOrCreateContact(){throw Error("should not create contact")},
    storeInboundClaim(){throw Error("should not create message")}};
  const service=createInboundMessageClaimService({
    senderIdentity,contacts:unsafe,processing:unsafe,
    database:{connect(){throw Error("must use injected rotation repository")}},
  });
  try{
    const [event]=parseIncomingMessages(callback([rotation()]));
    const saved=await service.storeIncomingMessage(event);
    assert.equal(saved,null);
    assert.equal(calls.length,1);
    assert.equal(calls[0].previousUserId,"MY.OldID123");
    assert.equal(calls[0].newUserId,"MY.NewID456");
  }finally{
    if(before===undefined)delete process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
    else process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=before;
  }
});
test("rotation repository failure rejects webhook durability instead of triggering AI",async()=>{
  const before=process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
  process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED="true";
  const service=createInboundMessageClaimService({
    senderIdentity:{async rotateSenderUserId(){throw new Error("rotation_not_verified");}},
  });
  try{
    await assert.rejects(service.storeIncomingMessage(
      parseIncomingMessages(callback([rotation()]))[0]),/rotation_not_verified/);
  }finally{
    if(before===undefined)delete process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
    else process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=before;
  }
});

test("conflicting identity rotation is durably audited without contact merge or AI",async()=>{
  const original=process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
  process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED="true";
  const audits=[],notices=[];
  const service=createInboundMessageClaimService({
    senderIdentity:{async rotateSenderUserId(){
      return {updated:false,reason:"replacement_identity_already_bound"};
    }},
    rotationAudit:async(items)=>{audits.push(...items);return items.length;},
    rotationNotify:async(items)=>{notices.push(...items);return true;},
  });
  try {
    const [incoming]=parseIncomingMessages(callback([rotation()]));
    assert.equal(await service.storeIncomingMessage(incoming),null);
    await Promise.resolve();
    assert.equal(audits.length,1);
    assert.match(audits[0].fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(audits[0].field,
      "bsuid_identity_rotation_replacement_identity_already_bound");
    assert.equal(audits[0].reason,"unsupported_whatsapp_event");
    assert.equal(notices.length,1);
    assert.equal(JSON.stringify(audits).includes("MY.OldID123"),false);
    assert.equal(JSON.stringify(audits).includes("MY.NewID456"),false);
  }finally{
    if(original===undefined)delete process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
    else process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=original;
  }
});
test("signed rotation audit failure rejects webhook so provider can retry",async()=>{
  const original=process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
  process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED="true";
  const service=createInboundMessageClaimService({
    senderIdentity:{async rotateSenderUserId(){
      return {updated:false,reason:"old_identity_not_bound"};
    }},
    rotationAudit:async()=>{throw new Error("audit_storage_unavailable");},
    rotationNotify:async()=>{throw new Error("must not notify without durable audit");},
  });
  try{
    await assert.rejects(service.storeIncomingMessage(
      parseIncomingMessages(callback([rotation()]))[0]),/audit_storage_unavailable/);
  }finally{
    if(original===undefined)delete process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED;
    else process.env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED=original;
  }
});
