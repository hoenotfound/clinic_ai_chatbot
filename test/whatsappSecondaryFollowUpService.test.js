"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const worker=require("../src/services/whatsappSecondaryFollowUpService");

const env={
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
  WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
};
const candidate={
  contact_id:80,sender_id:2,slot_hours:2,
  inbound_id:981,whatsapp_number:"60125554444",
  media_key:null,media_type:null,media_mime_type:null,media_filename:null,
  message_text:"Hi, would you like to know more about our services?",
};
const contact={id:80,channel:"whatsapp",mode:"ai",whatsapp_sender_key:"ariel",
  whatsapp_sender_id:2,whatsapp_number:candidate.whatsapp_number};

function fake({rows=[candidate],fresh=true,claim=true,
    throwSend=false,sendResult={success:true,wamid:"wamid.ariel-followup"}}={}) {
  const calls=[];
  const database={
    query:async(sql,args)=>{
      calls.push({sql,args});
      if(sql===worker.CANDIDATES_SQL)return{rows};
      if(sql===worker.RECHECK_SQL)return{rows:[{allowed:fresh}]};
      if(sql.includes("INSERT INTO whatsapp_sender_followup_attempts"))
        return{rows:claim?[{id:314}]:[]};
      return{rows:[],rowCount:1};
    },
  };
  const store={
    saveMessage:async(...args)=>{
      calls.push({save:args});
      return{id:912,contact_id:80};
    },
    setWhatsappMessageId:async(...args)=>{
      calls.push({persist:args});
      return{id:912,whatsapp_message_id:args[1]};
    },
  };
  const contacts={getContactById:async()=>contact};
  let sends=0;
  const sendText=async(payload)=>{
    sends++;
    calls.push({send:payload});
    if(throwSend)throw new Error("unknown Meta failure");
    return sendResult;
  };
  return{database,store,contacts,sendText,calls,get sends(){return sends}};
}

test("secondary followups never inherit Neutro content or start by default",async()=>{
  assert.equal(worker.enabled({}),false);
  assert.equal(worker.start({env:{},setIntervalFn:()=>{throw Error("unexpected timer")}}),false);
  const f=fake();
  assert.deepEqual(await worker.runOnce({...f,env:{}}),
    {disabled:true,attempted:0,accepted:0});
  assert.equal(f.calls.length,0);
  assert.match(worker.CANDIDATES_SQL,/sa\.sender_key=\$1/);
  assert.match(worker.CANDIDATES_SQL,/sc\.customer_wa_id/);
  assert.match(worker.CANDIDATES_SQL,/marketing_consent='opted_in'/);
  assert.match(worker.CANDIDATES_SQL,/whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(worker.CANDIDATES_SQL,/BETWEEN 7 AND 23/);
  assert.match(worker.CANDIDATES_SQL,/NOT EXISTS \(/);
  assert.match(worker.RECHECK_SQL,/attempt\.status='claimed'/);
  assert.match(worker.RECHECK_SQL,/ORDER BY l\.created_at DESC,l\.id DESC LIMIT 1/);
  assert.match(worker.RECHECK_SQL,/latest_lead\.marketing_consent='opted_in'/);
  assert.match(worker.RECHECK_SQL,/latest_lead\.stage_key/);
  assert.match(worker.RECHECK_SQL,/NULLIF\(BTRIM\(c\.whatsapp_opt_in_source\)/);
  assert.match(worker.CANDIDATES_SQL,/INTERVAL '8 hours'/);
  assert.match(worker.CANDIDATES_SQL,/newer_rule\.slot_hours>rule\.slot_hours/);
  assert.match(worker.RECHECK_SQL,/newer_rule\.slot_hours>rule\.slot_hours/);
});

test("one eligible Ariel followup is durably claimed before sender-specific send",async()=>{
  const f=fake();
  const result=await worker.runOnce({...f,env});
  assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
  assert.equal(f.sends,1);
  const claim=f.calls.find(x=>x.sql?.includes("INSERT INTO whatsapp_sender_followup_attempts"));
  const save=f.calls.find(x=>x.save);
  const send=f.calls.find(x=>x.send);
  const provider=f.calls.find(x=>x.persist);
  assert.ok(claim);
  assert.ok(save);
  assert.ok(send);
  assert.equal(send.send.origin,"followup");
  assert.equal(send.send.messageId,912);
  assert.equal(send.send.contact.whatsapp_sender_key,"ariel");
  assert.equal(save.save[8].isAutomatedFollowUp,true);
  assert.equal(save.save[8].whatsappTemplate.automatedSecondaryFollowup,true);
  assert.deepEqual(provider.persist,[912,"wamid.ariel-followup",{
    preserveVerifiedSecondaryReceipt:true,
  }]);
  const audit=f.calls.find(x=>x.sql?.includes("status='accepted'"));
  assert.ok(audit);
});

test("duplicate one-shot slot cannot reach any provider or save a second message",async()=>{
  const f=fake({claim:false});
  const result=await worker.runOnce({...f,env});
  assert.equal(result.attempted,0);
  assert.equal(f.sends,0);
  assert.equal(f.calls.some(x=>x.save),false);
});

test("live opt-out/staff takeover/service-window change blocks after claim",async()=>{
  const f=fake({fresh:false});
  const result=await worker.runOnce({...f,env});
  assert.equal(result.attempted,1);
  assert.equal(result.accepted,0);
  assert.equal(f.sends,0);
  assert.ok(f.calls.some(x=>x.sql?.includes("status='unknown'")));
});

test("provider exception marks attempt unknown and never retries automatically",async()=>{
  const f=fake({throwSend:true});
  const result=await worker.runOnce({...f,env});
  assert.equal(result.accepted,0);
  assert.equal(f.sends,1);
  assert.equal(f.calls.filter(x=>x.send).length,1);
  assert.ok(f.calls.some(x=>x.sql?.includes("status='unknown'")));
});

test("media followup uploads only through verified Ariel transport",async()=>{
  const row={...candidate,
    media_key:"ariel-private-video-key",media_type:"video",
    media_mime_type:"video/mp4",media_filename:"ariel-video.mp4",
  };
  const f=fake({rows:[row]});
  let uploads=0, actualSends=0;
  const result=await worker.runOnce({
    ...f,env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
    storage:{downloadMedia:async()=>{
      uploads++;return Buffer.from("video-bytes");
    }},
    videoApproved:()=>true,
    sendText:async(payload)=>{
      assert.equal(payload.origin,"followup");
      const got=await payload.dispatchTransport({
        uploadMedia:async()=>({success:true,mediaId:"11005"}),
        sendMediaById:async(type,id)=>{
          actualSends++;assert.equal(type,"video");assert.equal(id,"11005");
          return{success:true,wamid:"wamid.ariel-video"};
        },
      });
      return got;
    },
  });
  assert.equal(result.accepted,1);
  assert.equal(uploads,1);
  assert.equal(actualSends,1);
  assert.equal(f.calls.filter(x=>x.persist).length,1);
});

test("secondary video removed from primary config cannot create an outbound or upload",async()=>{
 const f=fake({rows:[{...candidate,media_key:"approved-then-removed-video",
  media_type:"video",media_mime_type:"video/mp4",media_filename:"clip.mp4"}]});
 const result=await worker.runOnce({...f,env:{
  ...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
 },videoApproved:()=>false,storage:{
  downloadMedia:async()=>assert.fail("Do not download revoked R2 video"),
 }});
 assert.equal(result.attempted,1);
 assert.equal(result.accepted,0);
 assert.equal(f.sends,0);
 assert.equal(f.calls.filter(x=>x.save).length,0);
 assert.ok(f.calls.some(x=>x.sql?.includes("status='unknown'")));
});
test("secondary video revoked while uploading is never submitted to WhatsApp",async()=>{
 const f=fake({rows:[{...candidate,media_key:"approved-video",
  media_type:"video",media_mime_type:"video/mp4",media_filename:"clip.mp4"}]});
 let approved=true,uploads=0,sends=0;
 const result=await worker.runOnce({...f,env:{
  ...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
 },videoApproved:()=>approved,
 storage:{downloadMedia:async()=>Buffer.from("video")},
 sendText:async payload=>payload.dispatchTransport({
  uploadMedia:async()=>{uploads++;approved=false;return{success:true,mediaId:"42"}},
  sendMediaById:async()=>{sends++;return{success:true,wamid:"wamid.unexpected"}},
 }),
 });
 assert.equal(uploads,1);
 assert.equal(sends,0);
 assert.equal(result.accepted,0);
 assert.ok(f.calls.some(x=>x.sql?.includes("status='unknown'")));
});
test("Phase B stays OFF unless the same secondary paid automation mode is enabled",async()=>{
  assert.equal(worker.enabled({...env,WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"}),false);
  const f=fake();
  const result=await worker.runOnce({...f,env:{...env,WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"}});
  assert.deepEqual(result,{disabled:true,attempted:0,accepted:0});
  assert.equal(f.calls.length,0);
});
test("imported history is excluded from candidate selection and pre-send recheck",()=>{
  assert.match(worker.CANDIDATES_SQL,/whatsapp_sender_coexistence_history_messages/);
  assert.match(worker.CANDIDATES_SQL,/h\.message_id=m\.id/);
  assert.match(worker.CANDIDATES_SQL,/h\.sender_id=sa\.id/);
  assert.match(worker.RECHECK_SQL,/whatsapp_sender_coexistence_history_messages/);
  assert.match(worker.RECHECK_SQL,/h\.message_id=inbound\.id/);
  assert.match(worker.RECHECK_SQL,/h\.sender_id=sa\.id/);
});
test("secondary video follow-up remains entirely passive when media is OFF",async()=>{
  const f=fake({rows:[{...candidate,media_key:"synthetic-video",
    media_type:"video",media_mime_type:"video/mp4",media_filename:"demo.mp4"}]});
  const result=await worker.runOnce({...f,env});
  assert.deepEqual(result,{disabled:false,attempted:0,accepted:0});
  assert.equal(f.sends,0);
  assert.equal(f.calls.some(c=>c.sql?.includes("INSERT INTO whatsapp_sender_followup_attempts")),false);
});
