"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const worker=require("../src/services/whatsappSecondaryAiMediaQueue");
const approved={
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
const job={id:2,sender_id:9,contact_id:21,whatsapp_number:"60125550000",
  inbound_message_id:41,sequence_no:0,caption:"Neutro approved promotion",
  image_url:"https://example.test/neutro-promo.jpg",
};
function mocks({result={success:true,wamid:"wamid.ariel-media"},ready=true}={}){
  const calls=[];
  const database={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql===worker.READY_SQL)return{rows:[job]};
    if(sql===worker.STILL_VALID_SQL)return{rows:[{allowed:ready}]};
    if(sql.includes("state='claimed'")&&sql.includes("RETURNING id"))return{rowCount:1,rows:[{id:2}]};
    return{rowCount:1,rows:[]};
  }};
  const contact={id:21,channel:"whatsapp",mode:"ai",needs_attention:false,
    whatsapp_sender_id:9,whatsapp_sender_key:"ariel",
    whatsapp_number:"60125550000"};
  const contacts={getContactById:async()=>contact,
    canSendAutomaticReviewMedia:async()=>true};
  const store={appendMessageForContact:async(...a)=>{
    calls.push({appended:a});return{id:89,contact_id:21};
  }};
  const messages={setWhatsappMessageId:async(...a)=>{
    calls.push({wamid:a});return{id:a[0]};
  }};
  const send=async(payload)=>{
    calls.push({send:payload});
    assert.equal(payload.origin,"ai_media");
    assert.equal(payload.contact.whatsapp_sender_key,"ariel");
    const provider=await payload.dispatchTransport({
      sendImageByUrl:async(url,caption)=>{
        assert.equal(url,job.image_url);assert.equal(caption,job.caption);
        return result;
      },
    });
    return provider;
  };
  const policy={previewSecondaryFreeformPolicy:async()=>({policyAllowed:true})};
  return{database,contacts,store,messageRepo:messages,policy,send,calls};
}
test("Ariel graphics disabled by default and missing clinic/billing authorization",async()=>{
  assert.equal(worker.enabled({}),false);
  assert.equal(worker.enabled({...approved,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"false"}),false);
  assert.equal(worker.enabled({...approved,WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"false"}),false);
  assert.equal(worker.enabled({...approved,WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"false"}),false);
  assert.equal(worker.enabled(approved),true);
  assert.equal(worker.start({env:{},setIntervalFn:()=>{throw Error("unexpected")}}),false);
  assert.deepEqual(await worker.runOnce({env:{}}),{disabled:true,accepted:0,pending:0});
});
test("sender-owned queue rejects unsafe images and a missing primary authorization",async()=>{
  let queried=false;
  const database={connect:async()=>{queried=true;throw Error("unexpected")}};
  const input={contactId:21,inboundMessageId:41,items:[{imageUrl:"http://not-https/p.jpg",caption:"ok"}]};
  assert.equal(await worker.enqueue(input,{database,env:approved}),false);
  assert.equal(await worker.enqueue({...input,items:[{imageUrl:"https://u:p@provider.test/x",caption:"bad"}]},
    {database,env:approved}),false);
  assert.equal(await worker.enqueue({...input,items:[{imageUrl:"https://valid.test/x",caption:"valid"}]},
    {database,env:{}}),false);
  assert.equal(queried,false);
});
test("accepted Ariel graphics use own transport once and retain verified receipt evidence",async()=>{
  const args=mocks();
  const r=await worker.runOnce({...args,env:approved});
  assert.deepEqual(r,{disabled:false,accepted:1,pending:0});
  assert.equal(args.calls.filter(x=>x.appended).length,1);
  assert.equal(args.calls.filter(x=>x.send).length,1);
  assert.equal(args.calls.filter(x=>x.wamid).length,1);
  assert.ok(args.calls.some(x=>x.sql?.includes("state='accepted'")));
  assert.equal(args.calls.some(x=>x.sql?.includes("whatsapp_result_media_queue")),false);
});
test("uncertain Ariel media never automatically resends",async()=>{
  const args=mocks({result:{success:false,unknown:true,code:"secondary_staff_unconfirmed"}});
  const r=await worker.runOnce({...args,env:approved});
  assert.equal(r.accepted,0);
  assert.ok(args.calls.some(x=>x.sql?.includes("state=$2")&&x.args?.[1]==="unknown"));
  assert.equal(args.calls.filter(x=>x.send).length,1);
});
test("unresolved prior billing defers safely without provider transmission",async()=>{
  const args=mocks();
  args.send=async()=>({success:false,unknown:false,code:"secondary_billing_previous_send_unresolved"});
  const r=await worker.runOnce({...args,env:approved});
  assert.equal(r.pending,1);
  assert.ok(args.calls.some(x=>x.sql?.includes("state='pending'")));
});
test("worker rechecks that no newer inbound, staff takeover, opt-out or night-time send is allowed",()=>{
  assert.match(worker.READY_SQL,/newer\.contact_id=c\.id/);
  assert.match(worker.READY_SQL,/staff\.sent_by_username IS NOT NULL/);
  assert.match(worker.READY_SQL,/whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(worker.STILL_VALID_SQL,/whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(worker.STILL_VALID_SQL,/BETWEEN 7 AND 23/);
  assert.match(worker.STILL_VALID_SQL,/job\.state='claimed'/);
});
