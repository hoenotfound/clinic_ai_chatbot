"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const worker=require("../src/services/whatsappSecondaryAiMediaQueue");
const approved={
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
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
  media_kind:"promotion",image_url:"https://example.test/neutro-promo.jpg",
};
function mocks({result={success:true,wamid:"wamid.ariel-media"},ready=true,jobImageUrl=job.image_url,
  preexistingMessageId=null}={}){
  const calls=[];
  const database={query:async(sql,args)=>{
    calls.push({sql,args});
    if(sql===worker.READY_SQL)return{rows:[{...job,image_url:jobImageUrl,
      outbound_message_id:preexistingMessageId}]};
    if(sql===worker.STILL_VALID_SQL)return{rows:[{allowed:ready}]};
    if(sql.includes("state='claimed'")&&sql.includes("RETURNING id"))return{rowCount:1,rows:[{id:2}]};
    if(preexistingMessageId && sql.includes("state=$2") && sql.includes("RETURNING outbound_message_id"))
      return{rowCount:1,rows:[{outbound_message_id:preexistingMessageId}]};
    if(sql.includes("UPDATE messages AS m") && sql.includes("delivery_status='cancelled'"))
      return{rowCount:1,rows:[{id:preexistingMessageId,contact_id:21,
        delivery_status:"cancelled",delivery_error:"Image not sent"}]};
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
  return{database,contacts,store,messageRepo:messages,policy,send,calls,
    getConfig:()=>({promotions:[{imageUrl:jobImageUrl,validFrom:"2020-01-01",validUntil:"2099-12-31"}]}),
  };
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
test("131060-only pending informational review permits approved secondary media; clinical review still blocks",async()=>{
  const allowed=mocks();
  const originalGet=allowed.contacts.getContactById;
  allowed.contacts.getContactById=async()=>({
    ...await originalGet(),needs_attention:true,
    attention_reason:"AI review requested: WhatsApp message unavailable (Meta 131060)",
  });
  const sent=await worker.runOnce({...allowed,env:approved});
  assert.equal(sent.accepted,1,
    "the earlier informational flag is not a reason to suppress an independently eligible image");
  assert.equal(allowed.calls.filter(x=>x.send).length,1);

  const blocked=mocks();
  const originalBlockedGet=blocked.contacts.getContactById;
  blocked.contacts.getContactById=async()=>({
    ...await originalBlockedGet(),needs_attention:true,
    attention_reason:"AI review requested: clinical question",
  });
  blocked.contacts.canSendAutomaticReviewMedia=async()=>false;
  const skipped=await worker.runOnce({...blocked,env:approved});
  assert.equal(skipped.accepted,0);
  assert.equal(blocked.calls.filter(x=>x.send).length,0);
  assert.equal(blocked.calls.filter(x=>x.appended).length,0,
    "a clinical safety review cannot create an outbound row");
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
test("removed promotion is cancelled without reserving a billable message",async()=>{
  const args=mocks();
  args.getConfig=()=>({promotions:[]});
  const result=await worker.runOnce({...args,env:approved});
  assert.equal(result.accepted,0);
  assert.equal(args.calls.filter(x=>x.send).length,0);
  assert.equal(args.calls.filter(x=>x.appended).length,0);
  assert.ok(args.calls.some(x=>x.sql?.includes("state=$2")&&x.args?.[1]==="expired"));
});
test("revoked private result after upload is NOT sent to Meta",async()=>{
  const url="/api/config/result-media/image/78";
  const args=mocks({jobImageUrl:url});
  let allowed=true, providerSends=0, uploads=0;
  args.getConfig=()=>({resultMedia:[{enabled:true,triggerMode:"service_enquiry",items:[{imageUrl:url}]}]});
  args.isAuthorizedImage=()=>allowed;
  args.loadClinicImage=async()=>({buffer:Buffer.from("fake-image"),mimeType:"image/png",filename:"x.png"});
  args.send=async payload=>{
    const outcome=await payload.dispatchTransport({
      uploadMedia:async()=>{uploads++;allowed=false;return{success:true,mediaId:"1234"}},
      sendMediaById:async()=>{providerSends++;return{success:true,wamid:"wamid.should-not-send"}},
    });
    return outcome;
  };
  const result=await worker.runOnce({...args,env:approved});
  assert.equal(uploads,1);
  assert.equal(providerSends,0);
  assert.equal(result.accepted,0);
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

test("nighttime image jobs survive quiet hours without exceeding the 23h service window",async()=>{
 const statements=[];
 const client={query:async(sql)=>{
  statements.push(sql);
  if(sql.includes("SELECT c.whatsapp_sender_id AS sender_id"))
    return{rows:[{sender_id:9,created_at:new Date("2026-11-02T00:30:00Z")}],rowCount:1};
  return{rows:[],rowCount:1};
 },release:()=>{}};
 const database={connect:async()=>client,
  query:async()=>({rows:[{eligible:true}],rowCount:1})};
 const ok=await worker.enqueue({contactId:21,inboundMessageId:41,
  items:[{imageUrl:"https://example.test/clinic.jpg",caption:"clinic approved"}]},
  {database,env:{...approved,WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary"}});
 assert.equal(ok,true);
 const insert=statements.find(x=>x.includes("INSERT INTO whatsapp_sender_ai_media_jobs"));
 assert.ok(insert);
 assert.match(insert,/INTERVAL '1 day 9 hours'/);
 assert.match(insert,/INTERVAL '9 hours'/);
 assert.match(insert,/INTERVAL '23 hours'/);
 assert.match(worker.READY_SQL,/BETWEEN 7 AND 23/);
 assert.match(worker.STILL_VALID_SQL,/BETWEEN 7 AND 23/);
});


test("superseded pending images are retired by exact sender; confirmed or claimed sends stay untouched",async()=>{
  const calls=[];
  const database={query:async(sql,params)=>{
    calls.push({sql,params});
    return{rowCount:1,rows:[{retired:2,messages_cancelled:1}]};
  }};
  const result=await worker.cancelObsoletePending({database,env:approved});
  assert.deepEqual(result,{disabled:false,cancelled:2});
  assert.equal(calls.length,1);
  const {sql,params}=calls[0];
  assert.match(sql,/job.state='pending'/);
  assert.match(sql,/job.expires_at<=NOW\(\)/);
  assert.match(sql,/newer.role='user'/);
  assert.match(sql,/staff.sent_by_username IS NOT NULL/);
  assert.match(sql,/NOT \(.*\)/s);
  assert.match(sql,/sa.sender_key=\$1/);
  assert.match(sql,/sa.meta_phone_number_id=\$2/);
  assert.match(sql,/sa.meta_account_id=\$3/);
  assert.match(sql,/state='expired'/);
  assert.match(sql,/delivery_status='cancelled'/);
  assert.match(sql,/m.whatsapp_message_id IS NULL/);
  assert.match(sql,/m.whatsapp_accepted_at IS NULL/);
  assert.match(sql,/a.state<>'rejected'/);
  assert.match(sql,/e.accepted=TRUE/);
  assert.deepEqual(params.slice(0,3),["ariel","100000000000002","200000000000002"]);
  assert.match(params[4],/Image not sent/);
  assert.deepEqual(await worker.cancelObsoletePending({
    database:{query:async()=>assert.fail("disabled media cleanup queried Neon")},
    env:{}
  }),{disabled:true,cancelled:0});
});

test("only a verified sender billing reconciliation wakes the delayed media queue",async()=>{
  const calls=[];
  const database={query:async(sql,params)=>{
    calls.push({sql,params});return{rowCount:1,rows:[{id:7}]};
  }};
  assert.equal(await worker.wakeAfterVerifiedReconciliation({
    contactIds:[21,21],database,env:approved,
  }),true);
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/job.state='pending'/);
  assert.doesNotMatch(calls[0].sql,/gate.state='idle'/);
  assert.match(calls[0].sql,/gate.owner_contact_id=job.contact_id/);
  assert.match(calls[0].sql,/job.contact_id=ANY\(\$4::int\[\]\)/);
  assert.match(calls[0].sql,/next_attempt_at=NOW\(\)/);
  assert.match(calls[0].sql,/job.expires_at>NOW\(\)/);
  assert.deepEqual(calls[0].params,["ariel","100000000000002","200000000000002",[21]]);
  assert.equal(await worker.wakeAfterVerifiedReconciliation({
    contactIds:[21],database:{query:async()=>({rowCount:0,rows:[]})},env:approved
  }),false);
  assert.equal(await worker.wakeAfterVerifiedReconciliation({
    database:{query:async()=>assert.fail("disabled media wake queried Neon")},env:{}
  }),false);
  assert.equal(await worker.wakeAfterVerifiedReconciliation({
    database:{query:async()=>assert.fail("empty contact scope queried Neon")},env:approved,
  }),false);
});

test("media placeholder starts queued, becomes uncertain when claimed, then queues on known pre-send billing hold",async()=>{
  const args=mocks();
  args.send=async()=>({success:false,unknown:false,code:"secondary_billing_previous_send_unresolved"});
  const result=await worker.runOnce({...args,env:approved});
  assert.equal(result.pending,1);
  const placeholder=args.calls.find(x=>x.appended).appended;
  assert.equal(placeholder.at(-1).initialDeliveryStatus,"queued");
  assert.ok(args.calls.some(x=>x.sql?.includes("delivery_status='unknown'")));
  const deferred=args.calls.find(x=>x.sql?.includes("WITH deferred AS"));
  assert.ok(deferred);
  assert.equal(deferred.args[0],2);
  assert.equal(deferred.args[1],90*1000);
  assert.ok(!args.calls.some(x=>x.wamid));
});

test("cancelled pending images notify only their verified sender and do not retry Meta",async()=>{
 const events=[];
 const realtime=require("../src/utils/realtimeEvents");
 const unsubscribe=realtime.subscribe("conversation_changed",e=>events.push(e));
 try{
   const database={query:async(sql)=>{
     assert.match(sql,/FROM cancelled_messages changed/);
     return{rows:[{retired:2,messages_cancelled:1,
       inbound_ids:[41],
       changed_messages:[{id:89,contact_id:21,delivery_status:"cancelled",
         delivery_error:"Image not sent"}]}],rowCount:1};
   }};
   assert.equal((await worker.cancelObsoletePending({database,env:approved})).cancelled,2);
   assert.deepEqual(events,[{
     channel:"whatsapp",businessPhoneNumberId:approved.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
     contactId:21,messageId:89,deliveryStatus:"cancelled",
     deliveryError:"Image not sent",reason:"delivery_status",
   }]);
 }finally{unsubscribe();}
});

test("revoked pre-send secondary image with an existing placeholder is cancelled without a Meta attempt",async()=>{
 const args=mocks({preexistingMessageId:89});
 args.getConfig=()=>({promotions:[]});
 const sent=[];
 const realtime=require("../src/utils/realtimeEvents");
 const unsubscribe=realtime.subscribe("conversation_changed",e=>sent.push(e));
 try{
   const r=await worker.runOnce({...args,env:approved});
   assert.equal(r.accepted,0);
   assert.ok(args.calls.some(c=>c.sql?.includes("UPDATE messages AS m") &&
     c.sql.includes("a.state<>'rejected'") &&
     c.sql.includes("e.accepted=TRUE")));
   assert.equal(args.calls.filter(c=>c.send).length,0);
   assert.deepEqual(sent.map(e=>e.deliveryStatus),["cancelled"]);
 }finally{unsubscribe();}
});

test("outdated queued Before & After images retire without calling Meta or re-sending",async()=>{
  const calls=[];
  const db={query:async (sql,params)=>{
    calls.push({sql,params});
    assert.match(sql,/job.state='pending'/);
    assert.match(sql,/job.expires_at<=NOW\(\)/);
    assert.match(sql,/newer\.role='user'/);
    assert.match(sql,/staff\.sent_by_username IS NOT NULL/);
    assert.match(sql,/whatsapp_opt_out_at IS NOT NULL/);
    assert.match(sql,/NOT EXISTS\(/);
    assert.match(sql,/outbound_message_evidence/);
    return{rows:[{retired:9,messages_cancelled:2,inbound_ids:[],changed_messages:[]}]};
  }};
  const result=await worker.cancelObsoletePending({database:db,env:approved});
  assert.deepEqual(result,{disabled:false,cancelled:9});
  assert.equal(calls.length,1);
  // A cancelled pending media job is not requeued or provider-dispatched.
  assert.doesNotMatch(calls[0].sql,/INSERT INTO whatsapp_sender_ai_media_jobs/);
});


test("location and treatment-method questions preserve media, while price and clinical concerns supersede it",async()=>{
  for(const text of [
    "Location", "location please", "Is it manual?", "Is it HIFU?",
    "请问是徒手吗", "是HIFu吗？",
  ]){
    assert.equal(worker.isHarmlessContinuationQuestion(text),true,text);
  }
  for(const text of ["四方脸","方脸","大小脸","下颌线","双下巴",
    "square face","jawline","muka petak"]){
    assert.equal(worker.isHarmlessContinuationQuestion(text,{
      mediaKind:"result",inboundText:"想了解 Neutro Sense TCM 3D 小颜术",
    }),true,text);
    assert.equal(worker.isHarmlessContinuationQuestion(text,{
      mediaKind:"result",inboundText:"我对骨盆调理有兴趣",
    }),false,"pelvic media must not survive face-shape switch");
    assert.equal(worker.isHarmlessContinuationQuestion(text),false,
      "facial reply cannot preserve arbitrary old media");
  }
  for(const text of [
    "How much", "how much for 1 session", "想要了解价钱", "按一次多少钱",
    "9D", "How much for 9D", "我是腹直肌分离", "体太不平衡",
    "Stop promotions", "不要一直发信息来", "Cancel appointment",
    "I'd like a different treatment", "Send the photo instead",
  ]){
    assert.equal(worker.isHarmlessContinuationQuestion(text),false,text);
  }
  for(const sql of [worker.READY_SQL,worker.STILL_VALID_SQL]){
    assert.match(sql,/AND NOT \(/);
    assert.match(sql,/BTRIM\(newer\.content\)/);
    assert.match(sql,/newer\.role='user'/);
    assert.match(sql,/(staff|human)\.sent_by_username IS NOT NULL/);
    assert.match(sql,/successor\.sender_id=job\.sender_id/);
    assert.match(sql,/successor\.contact_id=job\.contact_id/);
  }
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/newer\.media_url IS NULL/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/job\.media_kind='result'/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/inbound\.content ~\*/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/四方脸/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/newer\.media_mime_type IS NULL/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/CHAR_LENGTH\(BTRIM/);
  const calls=[];
  const database={query:async(sql,args)=>{
    calls.push({sql,args});
    return {rows:[{retired:0,messages_cancelled:0,inbound_ids:[],changed_messages:[]}],rowCount:1};
  }};
  await worker.cancelObsoletePending({database,env:approved});
  assert.match(calls[0].sql,/AND NOT \(/);
  assert.match(calls[0].sql,/BTRIM\(newer\.content\)/);
  assert.match(calls[0].sql,/job.state='pending'/);
  assert.match(calls[0].sql,/successor\.sender_id=job\.sender_id/);
  assert.match(calls[0].sql,/successor_inbound\.created_at/);
  assert.match(worker.HARMLESS_CONTINUATION_SQL,/BTRIM\(newer\.content\) ~\*/);
});

test("receipt wake includes already-due images but remains contact-bound and billing-gated",async()=>{
  const calls=[];
  const database={query:async(sql,args)=>{calls.push({sql,args});return{rowCount:1,rows:[{id:8}]}}};
  assert.equal(await worker.wakeAfterVerifiedReconciliation({
    contactIds:[42],database,env:approved,
  }),true);
  assert.equal(calls.length,1);
  assert.doesNotMatch(calls[0].sql,/job\.next_attempt_at>NOW\(\)/);
  assert.match(calls[0].sql,/job\.state='pending'/);
  assert.doesNotMatch(calls[0].sql,/gate\.state='idle'/);
  assert.match(calls[0].sql,/job\.contact_id=ANY\(\$4::int\[\]\)/);
  assert.match(calls[0].sql,/job\.expires_at>NOW\(\)/);
  assert.deepEqual(calls[0].args.slice(-1),[[42]]);
});

test("accepted image wakes after its state transition when the verified receipt arrived first",async()=>{
  const args=mocks();
  const r=await worker.runOnce({...args,env:approved});
  assert.equal(r.accepted,1);
  const accepted=args.calls.find(c=>c.sql?.includes("state='accepted'") &&
    c.sql.includes("accepted_wamid"));
  const wake=args.calls.find(c=>c.sql?.includes("UPDATE whatsapp_sender_ai_media_jobs AS job") &&
    c.sql.includes("gate.owner_contact_id=job.contact_id"));
  assert.ok(accepted);
  assert.ok(wake);
  assert.ok(args.calls.indexOf(wake)>args.calls.indexOf(accepted));
  assert.deepEqual(wake.args.slice(-1),[[job.contact_id]]);
  assert.equal(args.calls.filter(c=>c.send).length,1,"Meta is never retried");
});

test("Before & After results stay queued after ordinary customer questions",async()=>{
  // Promotion media is still superseded by most new messages. Result images
  // instead survive new location, price, and treatment-detail messages.
  for(const sql of [worker.READY_SQL,worker.STILL_VALID_SQL]){
    assert.match(sql,/job\.media_kind='result' AND/);
    assert.match(sql,/job\.media_kind<>'result' AND NOT/);
    assert.match(sql,/successor\.media_kind='result'/);
    assert.match(sql,/stop\|unsubscribe\|opt/);
    assert.match(sql,/c\.whatsapp_opt_out_at IS NULL/);
    assert.match(sql,/c\.whatsapp_marketing_opt_out_at IS NULL/);
    assert.match(sql,/sent_by_username IS NOT NULL/);
  }
  const statements=[];
  const db={query:async(sql)=>{
    statements.push(sql);
    return{rows:[{retired:0,messages_cancelled:0,inbound_ids:[],changed_messages:[]}]};
  }};
  await worker.cancelObsoletePending({database:db,env:approved});
  assert.equal(statements.length,1);
  assert.match(statements[0],/job\.media_kind='result' AND/);
  assert.match(statements[0],/job\.media_kind<>'result' AND NOT/);
  assert.match(statements[0],/successor\.media_kind='result'/);
  assert.match(statements[0],/job\.expires_at<=NOW\(\)/);
});
