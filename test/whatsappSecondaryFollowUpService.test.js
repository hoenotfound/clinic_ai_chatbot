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
  rule_version:"1790000000.860775",
  inbound_id:981,whatsapp_number:"60125554444",
  media_key:null,media_type:null,media_mime_type:null,media_filename:null,
  message_text:"Hi, would you like to know more about our services?",
  customer_texts:["How much is the pelvic treatment?"],
  treatment_interest:"骨盆调理",
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
  assert.match(worker.CANDIDATES_SQL,/inbound\.source_created_at >= \$9::timestamptz/);
  assert.match(worker.RECHECK_SQL,/inbound\.source_created_at >= \$11::timestamptz/);
  assert.match(worker.CANDIDATES_SQL,/lead\.marketing_consent,'unknown'\)<>'opted_out'/);
  assert.match(worker.CANDIDATES_SQL,/appointment_status,'none'\)/);
  assert.match(worker.RECHECK_SQL,/latest_lead\.stage_key/);
  assert.match(worker.RECHECK_SQL,/NULLIF\(BTRIM\(c\.whatsapp_opt_in_source\)/);
  assert.match(worker.CANDIDATES_SQL,/INTERVAL '8 hours'/);
  assert.match(worker.CANDIDATES_SQL,/preceding\.slot_hours<rule\.slot_hours/);
  assert.match(worker.RECHECK_SQL,/preceding\.slot_hours<rule\.slot_hours/);
  assert.match(worker.CANDIDATES_SQL,/preceding_sent\.status='accepted'/);
  assert.match(worker.RECHECK_SQL,/previous_step\.completed_at IS NOT NULL/);
  assert.doesNotMatch(worker.CANDIDATES_SQL,/newer_rule\.slot_hours>rule\.slot_hours/);
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

test("English fallback without a loaded clinic config remains supported",async()=>{
 const f=fake();
 const result=await worker.runOnce({...f,env,getConfig:()=>null});
 assert.equal(result.accepted,1);
 const text=f.calls.find(x=>x.save).save[2];
 assert.match(text,/treatment you asked about/);
 assert.doesNotMatch(text,/你/);
 assert.equal(f.calls.find(x=>x.send).send.text,text);
});
test("unclear follow-up language skips before consuming a one-shot attempt",async()=>{
 const f=fake({rows:[{...candidate,customer_texts:["ok","hi"]}]});
 const result=await worker.runOnce({...f,env});
 assert.deepEqual(result,{disabled:false,attempted:0,accepted:0});
 assert.equal(f.calls.some(x=>x.sql?.includes("INSERT INTO whatsapp_sender_followup_attempts")),false);
});
test("treatment-specific 6h video is selected without granting Inbox staff sending",async()=>{
 const selected={mediaKey:"approved-6h-video",mediaType:"video",
  mediaMimeType:"video/mp4",mediaFilename:"clinic-followup.mp4"};
 const f=fake({rows:[{...candidate,slot_hours:6,media_key:null,
   customer_texts:["Saya nak tahu rawatan ini"],treatment_interest:"骨盆调理"}]});
 let selectedCalled=0,mediaCalls=0;
 const result=await worker.runOnce({
  ...f,env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
   WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false"},
  getConfig:()=>({services:[{name:"骨盆调理"}],
    automatedFollowUp:{additionalSteps:[{message:"Malay followup",
      translations:{ms:"Kalau nak tahu rawatan tadi, boleh tanya ya 😊"}}]}}),
  videoSelection:params=>{selectedCalled++;
   assert.equal(params.treatmentInterest,"骨盆调理");return selected;},
  videoApproved:()=>true,
  storage:{downloadMedia:async()=>Buffer.from("approved video bytes")},
  sendText:async payload=>{
   assert.match(payload.text,/rawatan tadi/);
   assert.equal(payload.origin,"followup");
   assert.equal(payload.contact.whatsapp_sender_key,"ariel");
   return payload.dispatchTransport({
    uploadMedia:async()=>({success:true,mediaId:"777"}),
    sendMediaById:async(type,id,options)=>{
     mediaCalls++;assert.equal(type,"video");assert.equal(id,"777");
     assert.match(options.caption,/rawatan tadi/);
     return{success:true,wamid:"wamid.approved-video"};},
   });
  },
 });
 assert.equal(result.accepted,1);
 assert.equal(selectedCalled,1);
 assert.equal(mediaCalls,1);
});

test("secondary 2h reminder uses the exact live primary clinic text, not a separate translation",async()=>{
 const copy={automatedFollowUp:{
   message:"Original Chinese text",
   translations:{en:"Primary approved assessment invitation English",ms:"Primary Malay",zh:"Primary Chinese"},
   serviceOverrides:[{serviceName:"骨盆调理",message:"Pelvic Chinese",
     translations:{en:"Approved pelvic assessment English",ms:"Pelvic Malay",zh:"Pelvic Chinese"}}],
 },services:[{name:"骨盆调理"}],serviceAliases:[]};
 const f=fake();
 const result=await worker.runOnce({...f,env,getConfig:()=>copy});
 assert.equal(result.accepted,1);
 assert.equal(f.calls.find(x=>x.save)?.save[2],"Approved pelvic assessment English");
 assert.equal(f.calls.find(x=>x.send)?.send.text,"Approved pelvic assessment English");
});
test("secondary follow-up video cannot inherit stale CRM treatment after explicit topic switch",async()=>{
 const cfg={services:[{name:"骨盆调理"},{name:"9D 逆龄抗衰"}],
   serviceAliases:[{alias:"9D lift",officialService:"9D 逆龄抗衰"}],
   automatedFollowUp:{message:"General",translations:{en:"General English"},
     serviceOverrides:[{serviceName:"骨盆调理",translations:{en:"Pelvic English"}}]}};
 const f=fake({rows:[{...candidate,customer_texts:["What about 9D lift?"],
   treatment_interest:"骨盆调理"}]});
 let target=null;
 const result=await worker.runOnce({...f,env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
   getConfig:()=>cfg,
   videoSelection:args=>{target=args.treatmentInterest;return null;}});
 assert.equal(result.accepted,1);
 assert.equal(target,"9D 逆龄抗衰");
 assert.equal(f.calls.find(x=>x.send).send.text,"General English");
});


test("pre-send revision matches exact PostgreSQL microseconds instead of rounded JS Date",async()=>{
 const f=fake();
 const result=await worker.runOnce({...f,env});
 assert.equal(result.accepted,1);
 const recheck=f.calls.find(x=>x.sql===worker.RECHECK_SQL);
 assert.equal(recheck.args[6],candidate.rule_version);
 assert.match(worker.RECHECK_SQL,/EXTRACT\(EPOCH FROM rule\.updated_at\)::text=\$7::text/);
 assert.doesNotMatch(worker.RECHECK_SQL,/rule\.updated_at=\$7::timestamptz/);
 assert.match(worker.CANDIDATES_SQL,/EXTRACT\(EPOCH FROM rule\.updated_at\)::text AS rule_version/);
});

test("2h/6h use primary reply anchor but 20h still protects the customer window",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
  assert.match(sql,/first_reply\.at/);
  assert.match(sql,/first_reply\.at END/);
  assert.match(sql,/WHEN rule\.slot_hours=20/);
  assert.match(sql,/reply\.is_automated_follow_up IS DISTINCT FROM TRUE/);
  assert.match(sql,/reply_context\.conversation_id=sc\.id/);
 }
 assert.match(worker.POTENTIAL_DUE_SQL,/first_reply\.at/);
});


test("sequential sender follow-ups never skip FU1 for FU2 or send after a failed previous step",()=>{
  for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
    assert.match(sql,/preceding\.enabled=TRUE/);
    assert.match(sql,/preceding\.slot_hours<rule\.slot_hours/);
    assert.match(sql,/preceding_sent\.anchor_message_id=inbound\.id/);
    assert.match(sql,/preceding_sent\.status='accepted'/);
    assert.match(sql,/previous_step\.slot_hours IS NULL OR previous_step\.completed_at IS NOT NULL/);
    assert.match(sql,/GREATEST\(/);
    assert.match(sql,/previous_step\.completed_at \+/);
    assert.match(sql,/rule\.slot_hours - previous_step\.slot_hours/);
  }
  assert.match(worker.RECHECK_SQL,/prior_problem\.status IN\('unknown','blocked'\)/);
  assert.match(worker.POTENTIAL_DUE_SQL,/previous_step\.completed_at/);
  assert.doesNotMatch(worker.CANDIDATES_SQL,/newer_rule\.slot_hours/);
});

test("secondary reminders exclude closed, non-patient and out-of-area enquiries at both SQL gates",()=>{
  for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
    assert.match(sql,/health\[\[:space:\]\]\+professional/);
    assert.match(sql,/谢谢/);
    assert.match(sql,/penang/);
    assert.match(sql,/same_slot\.status='accepted'/);
    assert.match(sql,/same_slot\.slot_hours=rule\.slot_hours/);
    assert.match(sql,/INTERVAL '12 hours'/);
  }
  assert.match(worker.CANDIDATES_SQL,/m\.role,m\.content FROM messages m/);
  assert.match(worker.CANDIDATES_SQL,/same_slot\.completed_at > \$4::timestamptz/);
  assert.match(worker.RECHECK_SQL,/same_slot\.completed_at > NOW\(\)/);
});


test("20h secondary follow-up invokes existing personalized generator and saves exactly one message",async()=>{
  const f=fake({rows:[{...candidate,slot_hours:20,media_key:null}]});
  let calls=0;
  const result=await worker.runOnce({
    ...f,
    env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
    getConfig:()=>({automatedFollowUp:{
      message:"2h treatment check-in",
      additionalSteps:[
        {message:"6h check-in"},
        {message:"Would you like to arrange a personal posture assessment?"},
      ],
    }}),
    personalize20h:async ({candidate:row})=>{
      calls++;
      assert.equal(row.slot_hours,20);
      return {ok:true,message:"您好，我们可以安排一对一体态评估，方便告诉我您较关注哪方面吗？",mode:"ai_personalized"};
    },
  });
  assert.equal(calls,1);
  assert.deepEqual(result,{disabled:false,attempted:1,accepted:1});
  assert.equal(f.sends,1);
  assert.equal(f.calls.filter(x=>x.save).length,1);
  assert.equal(f.calls.filter(x=>x.sql?.startsWith("UPDATE whatsapp_sender_followup_attempts SET status='accepted'")).length,1);
});

test("20h pre-save AI exception records fixed phase and never sends or retries",async()=>{
  const f=fake({rows:[{...candidate,slot_hours:20,media_key:null}]});
  const phases=[];
  const result=await worker.runOnce({
    ...f,
    env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
    getConfig:()=>({automatedFollowUp:{
      message:"2h treatment check-in",
      additionalSteps:[
        {message:"6h check-in"},
        {message:"Would you like to arrange a personal posture assessment?"},
      ],
    }}),
    personalize20h:async()=>{throw Error("test secret that must never reach logs");},
    onUnexpectedFailure:({phase,slot})=>phases.push({phase,slot}),
  });
  assert.equal(result.attempted,1);
  assert.equal(result.accepted,0);
  assert.equal(f.sends,0);
  assert.deepEqual(phases,[{phase:"ai_generation",slot:20}]);
  assert.equal(f.calls.filter(x=>x.save).length,0);
  const failed=f.calls.find(x=>x.sql?.includes("SET status='unknown'"));
  assert.equal(failed?.args?.[1],"sender_followup_before_save_ai_generation");
  assert.equal(JSON.stringify(f.calls).includes("test secret"),false);
});
