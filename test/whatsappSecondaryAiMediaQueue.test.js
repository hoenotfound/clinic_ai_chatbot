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
function mocks({result={success:true,wamid:"wamid.ariel-media"},ready=true,jobImageUrl=job.image_url}={}){
  const calls=[];
  const database={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql===worker.READY_SQL)return{rows:[{...job,image_url:jobImageUrl}]};
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
        assert.equal(url,jobImageUrl);assert.equal(caption,job.caption);
        return result;
      },
      uploadMedia:async(buffer,mimeType,filename)=>{
        calls.push({upload:{buffer,mimeType,filename}});
        return{success:true,mediaId:"77777"};
      },
      sendMediaById:async(type,id,options)=>{
        calls.push({sendMediaById:{type,id,options}});
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
test("private before/after image loads trusted DB bytes and uploads through secondary transport",async()=>{
 const url="/api/config/result-media/image/78";
 const args=mocks({jobImageUrl:url});
 args.loadClinicImage=async x=>{
  assert.equal(x,url);
  return{buffer:Buffer.from("image-bytes"),mimeType:"image/png",filename:"clinic-result.png"};
 };
 const result=await worker.runOnce({...args,env:approved});
 assert.equal(result.accepted,1);
 assert.equal(args.calls.filter(c=>c.upload).length,1);
 const request=args.calls.find(c=>c.sendMediaById).sendMediaById;
 assert.deepEqual(request,{type:"image",id:"77777",options:{caption:job.caption}});
 assert.equal(args.calls.filter(c=>c.wamid).length,1);
});
test("missing private image never falls back to private HTTP URL or sends a Graph message",async()=>{
 const url="/api/config/result-media/image/78";
 const args=mocks({jobImageUrl:url});
 args.loadClinicImage=async()=>null;
 const result=await worker.runOnce({...args,env:approved});
 assert.equal(result.accepted,0);
 assert.equal(args.calls.filter(c=>c.upload || c.sendMediaById).length,0);
 assert.ok(args.calls.some(c=>c.sql?.includes("state=$2")&&c.args?.[1]==="unknown"));
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

test("stale claimed secondary images are quarantined once, never automatically resent",async()=>{
  const calls=[];
  const database={query:async(sql,args)=>{
    calls.push({sql,args});
    return{rows:[{id:13,outbound_message_id:89},
      {id:14,outbound_message_id:null}]};
  }};
  const messageRepo={markDeliveryUnknownIfUnconfirmed:async(id,reason)=>{
    calls.push({marked:id,reason});
  }};
  const report=await worker.quarantineStaleClaims({database,env:approved,messageRepo});
  assert.deepEqual(report,{disabled:false,quarantined:2});
  const query=calls[0];
  assert.match(query.sql,/job.state='claimed'/);
  assert.match(query.sql,/state='unknown'/);
  assert.match(query.sql,/30 minutes/);
  assert.match(query.sql,/sender.sender_key=\$1/);
  assert.match(query.sql,/sender.meta_phone_number_id=\$2/);
  assert.match(query.sql,/sender.meta_account_id=\$3/);
  assert.deepEqual(query.args,["ariel","100000000000002","200000000000002"]);
  assert.equal(calls.filter(c=>c.marked).length,1);
  assert.equal(calls.find(c=>c.marked)?.marked,89);
  assert.match(calls.find(c=>c.marked)?.reason,/Verify the actual WhatsApp delivery/);
  assert.ok(!calls.some(c=>c.send));
});
test("no sender authorization means stale images cannot be touched",async()=>{
  const database={query:async()=>assert.fail("disabled secondary worker queried the DB")};
  const result=await worker.quarantineStaleClaims({database,env:{}});
  assert.deepEqual(result,{disabled:true,quarantined:0});
});
