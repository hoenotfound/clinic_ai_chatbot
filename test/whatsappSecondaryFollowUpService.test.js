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
  contact_id:80,conversation_id:880,inbound_at:new Date("2026-11-12T16:45:14Z"),
  sender_id:2,slot_hours:2,
  rule_version:"1790000000.860775",
  inbound_id:981,whatsapp_number:"60125554444",
  media_key:null,media_type:null,media_mime_type:null,media_filename:null,
  message_text:"Hi, would you like to know more about our services?",
  customer_texts:["How much is the pelvic treatment?"],
  treatment_interest:"骨盆调理",
};
const contact={id:80,channel:"whatsapp",mode:"ai",whatsapp_sender_key:"ariel",
  whatsapp_sender_id:2,whatsapp_number:candidate.whatsapp_number};

function fake({rows=[candidate],fresh=true,claim=true,staffVideoAllowed=true,
    throwSend=false,sendResult={success:true,wamid:"wamid.ariel-followup"}}={}) {
  const calls=[];
  const database={
    query:async(sql,args)=>{
      calls.push({sql,args});
      if(sql===worker.CANDIDATES_SQL)return{rows};
      if(sql===worker.RECHECK_SQL)return{rows:[{allowed:fresh}]};
      if(sql===worker.RECENT_STAFF_VIDEO_SQL)return{rows:[{allowed:staffVideoAllowed}]};
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

test("genuine re-engagement carries only verified prior accepted stages, never duplicate media",()=>{
 const sql=worker.PREVIOUS_STEP_SQL;
 for(const proof of [
   /preceding_sent.anchor_message_id=inbound.id/,
   /preceding_sent.status='accepted'/,
   /earlier.status='accepted'/,
   /earlier.completed_at<inbound.created_at/,
   /earlier.completed_at>=inbound.created_at-INTERVAL '24 hours'/,
   /previous_context.conversation_id=sc.id/,
   /previous_inbound.whatsapp_message_id IS NOT NULL/,
   /imported.message_id=previous_inbound.id/,
   /human_between.sent_by_username IS NOT NULL/,
   /uncertain_between.status IN\('unknown','blocked'\)/,
   /changed.source_message_id>earlier.anchor_message_id/,
   /changed.source_message_id<=inbound.id/,
   /previous_outbound.whatsapp_template->>'treatmentInterest'/,
   /changed.status IS DISTINCT FROM 'selected'/,
   /ORDER BY preceding.slot_hours DESC LIMIT 1/,
 ]) assert.match(sql,proof);
 assert.doesNotMatch(sql,/earlier.status IN\('claimed','unknown'\)/);
 // Each stage still has its own one-shot anchor, current opt-in, booking,
 // consent, treatment and 24h policy checks before provider dispatch.
 for(const query of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
   assert.match(query,/previous_step.completed_at IS NOT NULL/);
   assert.match(query,/inbound.created_at \+ INTERVAL '24 hours'/);
   assert.match(query,/whatsapp_marketing_opt_out_at IS NULL/);
 }
 assert.match(worker.CANDIDATES_SQL,/same_slot.status='accepted'/);
 assert.match(worker.CANDIDATES_SQL,/INTERVAL '7 days'/);
});

test("quiet-hour-delayed 6h video cannot push the 20h check-in out of its 24h window",()=>{
  const candidate=worker.CANDIDATES_SQL, recheck=worker.RECHECK_SQL;
  const duePattern=/CASE WHEN rule\.slot_hours=20[\s\S]*?INTERVAL '15 minutes'/;
  for(const sql of [candidate,recheck]){
    assert.match(sql,duePattern,"20h must use a short post-video buffer, not the old fourteen-hour gap");
    assert.match(sql,/rule\.slot_hours<>20 OR[\s\S]*?inbound\.created_at \+ INTERVAL '24 hours'/);
    assert.match(sql,/previous_step\.completed_at IS NOT NULL/);
    assert.match(sql,/previous\.status IN\('unknown','blocked'\)|prior_problem\.status IN\('unknown','blocked'\)/);
  }
  const inbound=Date.parse("2026-11-10T12:36:14.753Z");
  const quietHourDelayedSix=Date.parse("2026-11-10T23:00:08Z");
  const due=Math.max(inbound+20*3600000,quietHourDelayedSix+15*60000);
  assert.equal(new Date(due).toISOString(),"2026-11-11T08:36:14.753Z",
    "9D #8997 reminder becomes due 16:36 MYT, not 21:00 after the window");
  assert.ok(due<inbound+24*3600000);
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
  assert.equal(save.save[8].whatsappTemplate.treatmentInterest,null,
    "unverified/ambiguous service never gets a fabricated treatment snapshot");
  assert.deepEqual(provider.persist,[912,"wamid.ariel-followup",{
    preserveVerifiedSecondaryReceipt:true,
  }]);
  const audit=f.calls.find(x=>x.sql?.includes("status='accepted'"));
  assert.ok(audit);
});

test("verified service snapshot is written only from the confirmed treatment",()=>{
 const source=worker.runOnce.toString();
 assert.match(source,/treatmentInterest:confirmedTreatment\|\|null/);
 assert.match(source,/const confirmedTreatment=candidate\.recovery_no_selection\?null:choice.treatment/);
 assert.match(source,/chooseSecondaryFollowUpTreatment/);
 // A confirmed service is persisted with a new follow-up, but no text-only
 // or uncertain choice may create a fabricated treatment classification.
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
  assert.ok(f.calls.some(x=>x.sql?.includes("status='blocked'")));
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
 assert.ok(f.calls.some(x=>x.sql?.includes("status='blocked'")));
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

test("20h AI skip sends one reviewed neutral reminder in the customer's language",async()=>{
 const samples=[
  ["en","Can you explain how the first visit works?",/first assessment/],
  ["zh","我想了解骨盆调理的流程",/一对一评估流程/],
  ["ms","Saya nak tahu tentang rawatan dan penilaian",/penilaian pertama/],
 ];
 for(const [language,customerText,copy] of samples){
  const f=fake({rows:[{...candidate,slot_hours:20,media_key:null,
    customer_texts:[customerText],first_reply_text:customerText}]});
  const result=await worker.runOnce({
   ...f,env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
   getConfig:()=>({automatedFollowUp:{
    message:"2h service reminder",translations:{en:"2h",zh:"2h",ms:"2h"},
    additionalSteps:[{message:"6h service reminder"},
      {message:"20h review",translations:{en:"20h",zh:"20h",ms:"20h"}}],
   }}),
   personalize20h:async()=>({ok:false,code:"secondary_20h_ai_skipped"}),
  });
  assert.deepEqual(result,{disabled:false,attempted:1,accepted:1},language);
  assert.equal(f.sends,1,language);
  const saved=f.calls.find(x=>x.save)?.save;
  assert.match(saved[2],copy,language);
  assert.doesNotMatch(saved[2],/RM ?[0-9]+|骨盆调理|9D逆龄|9D 逆龄/,language);
  assert.equal(saved[8].isAutomatedFollowUp,true);
  assert.equal(f.calls.filter(x=>x.sql?.startsWith("UPDATE whatsapp_sender_followup_attempts SET status='accepted'")).length,1);
 }
});

test("20h AI fallback does not request marketing consent even for verified ads",async()=>{
 const reminderConfig=()=>({automatedFollowUp:{
  message:"2h",additionalSteps:[{message:"6h"},
    {message:"20h",translations:{en:"20h English"}}],
 }});
 const campaignEnv={...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:"2026-11-12T08:00:00Z"};
 for(const [isAd,inboundAt] of [
  [true,"2026-11-12T08:30:00Z"],
  [false,"2026-11-12T08:30:00Z"],
  [true,"2026-11-12T07:59:59Z"],
 ]){
  const row={...candidate,slot_hours:20,media_key:null,
   customer_texts:["Can you explain how the assessment works?"],
   verified_meta_ad:isAd,lead_marketing_consent:"unknown",inbound_at:inboundAt};
  const f=fake({rows:[row]});
  const result=await worker.runOnce({...f,env:campaignEnv,getConfig:reminderConfig,
   personalize20h:async()=>({ok:false,code:"secondary_20h_ai_unavailable"})});
  assert.equal(result.accepted,1);
  const saved=f.calls.find(x=>x.save)?.save;
  assert.match(saved[2],/first assessment/);
  assert.doesNotMatch(saved[2],/I agree to receive WhatsApp follow-ups|若希望之后6天内继续收到/);
  assert.equal(f.calls.find(x=>x.send)?.send?.interactiveButtons,undefined);
  assert.equal(f.calls.filter(x=>x.save).length,1);
  assert.equal(f.sends,1);
 }
});

test("20h does not fallback for customer replies, missing proof or revoked policy",async()=>{
 for(const code of ["secondary_20h_customer_replied",
   "secondary_20h_anchor_missing","secondary_20h_context_unavailable",
   "secondary_20h_context_invalid","secondary_20h_ai_disabled"]){
  const f=fake({rows:[{...candidate,slot_hours:20,media_key:null}]});
  const result=await worker.runOnce({...f,
   env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
   getConfig:()=>({automatedFollowUp:{message:"2h",additionalSteps:[
    {message:"6h"},{message:"20h"}]}}),
   personalize20h:async()=>({ok:false,code})});
  assert.equal(result.attempted,1,code);
  assert.equal(result.accepted,0,code);
  assert.equal(f.sends,0,code);
  assert.equal(f.calls.some(x=>x.save),false,code);
  const blocked=f.calls.find(x=>x.sql?.includes("status='blocked'"));
  assert.equal(blocked?.args?.[1],code);
 }
 const f=fake({rows:[{...candidate,slot_hours:20}],fresh:false});
 const result=await worker.runOnce({...f,
  env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
  personalize20h:async()=>({ok:false,code:"secondary_20h_ai_skipped"})});
 assert.equal(result.accepted,0);
 assert.equal(f.sends,0);
 assert.equal(f.calls.some(x=>x.save),false);
});

test("20h fallback respects one-shot claim and never retries ambiguous sends",async()=>{
 const row={...candidate,slot_hours:20,customer_texts:["Can I arrange an assessment?"]};
 const personalize20h=async()=>({ok:false,code:"secondary_20h_ai_skipped"});
 const options={env:{...env,WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
  personalize20h,getConfig:()=>({automatedFollowUp:{message:"2h",additionalSteps:[
   {message:"6h"},{message:"20h",translations:{en:"20h"}}]}})};
 const noClaim=fake({rows:[row],claim:false});
 const first=await worker.runOnce({...noClaim,...options});
 assert.equal(first.accepted,0);
 assert.equal(first.attempted,0);
 assert.equal(noClaim.sends,0);
 const unknown=fake({rows:[row],sendResult:{success:false,unknown:true,code:"provider_unconfirmed"}});
 const second=await worker.runOnce({...unknown,...options});
 assert.equal(second.attempted,1);
 assert.equal(second.accepted,0);
 assert.equal(unknown.sends,1);
 assert.equal(unknown.calls.filter(x=>x.sql?.includes("status='unknown'")).length,1);
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
  const failed=f.calls.find(x=>x.sql?.includes("SET status='blocked'"));
  assert.equal(failed?.args?.[1],"sender_followup_before_save_ai_generation");
  assert.equal(JSON.stringify(f.calls).includes("test secret"),false);
});

test("secondary follow-up query keeps a bounded verified sender-only treatment history",()=>{
 const sql=worker.CANDIDATES_SQL;
 assert.match(sql,/language_turn\.whatsapp_message_id IS NOT NULL/);
 assert.match(sql,/language_turn\.created_at >= inbound\.created_at - INTERVAL '24 hours'/);
 assert.match(sql,/language_context\.conversation_id=sc\.id/);
 assert.match(sql,/historical\.sender_id=sa\.id AND historical\.message_id=language_turn\.id/);
 assert.match(sql,/ORDER BY language_turn\.created_at DESC,language_turn\.id DESC LIMIT 20/);
});

test("Neutro #8943 2h and 6h select pelvic videos despite later branch and package questions",async()=>{
 const history=[
  "哪一分行",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "RM388和RM288的配套有什么分别？",
  "想了解价钱看看",
  "我平时久坐，腰有点酸，小腹也比较突出。",
  "我对你们的骨盆调理有兴趣，想了解一下。",
 ];
 const config={
  services:[{name:"骨盆调理"},{name:"9D 逆龄抗衰"}],
  serviceAliases:[{alias:"骨盆",officialService:"骨盆调理"}],
  automatedFollowUp:{
   message:"Default",translations:{zh:"General 2h"},
   serviceOverrides:[{serviceName:"骨盆调理",translations:{zh:"Pelvic 2h"}}],
   additionalSteps:[{message:"Default 6h",translations:{zh:"General 6h"},
     serviceOverrides:[{serviceName:"骨盆调理",translations:{zh:"Pelvic 6h"}}]}],
  },
 };
 for(const [slot,caption] of [[2,"Pelvic 2h"],[6,"Pelvic 6h"]]){
  const f=fake({rows:[{...candidate,slot_hours:slot,
   customer_texts:history,treatment_interest:null}]});
  let selected=0,mediaSent=0;
  const result=await worker.runOnce({
   ...f,env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
   getConfig:()=>config,
   videoSelection:params=>{
    selected++;assert.equal(params.treatmentInterest,"骨盆调理");
    return{mediaKey:"approved-pelvic-"+slot,mediaType:"video",
     mediaMimeType:"video/mp4",mediaFilename:"clinic-followup.mp4"};
   },
   videoApproved:()=>true,
   storage:{downloadMedia:async()=>Buffer.from("approved video")},
   sendText:async payload=>{
    assert.equal(payload.text,caption);
    return payload.dispatchTransport({
     uploadMedia:async()=>({success:true,mediaId:"1234"}),
     sendMediaById:async(kind,id,options)=>{
      mediaSent++;assert.equal(kind,"video");assert.equal(id,"1234");
      assert.equal(options.caption,caption);
      return{success:true,wamid:"wamid.pelvic-"+slot};
     },
    });
   },
  });
  assert.equal(result.accepted,1);
  assert.equal(selected,1);
  assert.equal(mediaSent,1);
  assert.equal(f.calls.find(x=>x.save).save[8].mediaKey,"approved-pelvic-"+slot);
 }
});

test("secondary 3D ad cannot replace a persisted 9D choice in video or caption",async()=>{
 const config={
  services:[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"}],
  serviceAliases:[{alias:"3D",officialService:"3D 小颜术"},
    {alias:"9D",officialService:"9D 逆龄抗衰"}],
  automatedFollowUp:{
   message:"General 2h",translations:{en:"General 2h"},
   serviceOverrides:[{serviceName:"3D 小颜术",translations:{en:"3D 2h"}},
    {serviceName:"9D 逆龄抗衰",translations:{en:"9D 2h"}}],
   additionalSteps:[{message:"General 6h",translations:{en:"General 6h"},
     serviceOverrides:[{serviceName:"3D 小颜术",translations:{en:"3D 6h"}},
      {serviceName:"9D 逆龄抗衰",translations:{en:"9D 6h"}}]}],
  },
 };
 for(const slot of [2,6]){
  const f=fake({rows:[{...candidate,slot_hours:slot,
   customer_texts:["Where is your branch?","What is the difference?"],
   treatment_interest:"3D 小颜术",verified_treatment_status:"selected",
   verified_treatment_name:"9D 逆龄抗衰",
   ad_followup_source:"meta_ads",ad_followup_headline:"3D 小颜术",
   ad_followup_body:"Our 3D facial contouring treatment"}]});
  let sends=0;
  const result=await worker.runOnce({
   ...f,env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
   getConfig:()=>config,
   videoSelection:({treatmentInterest})=>{
    assert.equal(treatmentInterest,"9D 逆龄抗衰");
    return{mediaKey:"approved-9d-"+slot,mediaType:"video",
      mediaMimeType:"video/mp4",mediaFilename:"clinic-9d.mp4"};
   },
   videoApproved:()=>true,
   storage:{downloadMedia:async()=>Buffer.from("approved video")},
   sendText:async payload=>{
    assert.equal(payload.text,"9D "+slot+"h");
    return payload.dispatchTransport({
      uploadMedia:async()=>({success:true,mediaId:"verified9d"}),
      sendMediaById:async(kind,id,options)=>{
        sends++;assert.equal(kind,"video");
        assert.equal(id,"verified9d");
        assert.equal(options.caption,"9D "+slot+"h");
        return{success:true,wamid:"wamid.verified-9d-"+slot};
      },
    });
   },
  });
  assert.equal(result.accepted,1);
  assert.equal(sends,1);
  assert.equal(f.calls.find(x=>x.save).save[8].mediaKey,"approved-9d-"+slot);
 }
});


test("verified WhatsApp Business App replies are permitted only as safe service anchors",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
   assert.match(sql,/reply.sent_by_username IS NOT NULL/);
   assert.match(sql,/reply.whatsapp_customer_mutation/);
   assert.match(sql,/reply.content NOT LIKE '🗑️ %'/);
   assert.match(sql,/reply.content NOT LIKE '\[media_placeholder%'/);
   assert.match(sql,/whatsapp_sender_coexistence_history_messages imported_staff/);
   assert.match(sql,/first_reply.staff_pending_action/);
   assert.match(sql,/first_reply.staff_question OR rule.slot_hours=2\s+OR \(/);
   assert.match(sql,/c.takeover_by IS NULL/);
   assert.doesNotMatch(sql,/human.created_at,human.id\)>\(first_reply.at,first_reply.id\)/);
   assert.match(sql,/reply.sent_by_username IS NULL\) DESC/);
   assert.match(sql,/reply.is_forwarded,FALSE\)=FALSE/);
   assert.match(sql,/inbound.created_at \+ INTERVAL '24 hours'/);
   assert.match(sql,/CASE WHEN first_reply.staff_reply AND NOT/);
 }
});
test("manual unanswered staff question sends one gentle text reminder instead of media",async()=>{
 const manual={...candidate,staff_reply:true,staff_question:true,
   first_reply_text:"请问您是顺产还是剖腹产呢？",customer_texts:["超过6周"]};
 const f=fake({rows:[manual]});
 const result=await worker.runOnce({...f,env});
 assert.equal(result.accepted,1);
 const saved=f.calls.find(x=>x.save)?.save;
 assert.match(saved[2],/刚才的问题/);
 assert.equal(saved[8].mediaKey,null);
 assert.equal(saved[8].isAutomatedFollowUp,true);
});


test("verified 131060 recovery keeps neutral 2h, 6h and 20h messages after an ordinary staff question",async()=>{
 const unsupported="📎 [Customer sent a WhatsApp message that could not be displayed]";
 for(const slot of [2,6,20]){
  const recovery={...candidate,slot_hours:slot,recovery_no_selection:true,
   staff_reply:true,staff_question:true,
   first_reply_text:"请问您想了解哪方面的护理呢？",
   customer_texts:[unsupported]};
  const f=fake({rows:[recovery]});
  const result=await worker.runOnce({...f,env});
  assert.equal(result.accepted,1,"recovery slot "+slot);
  const saved=f.calls.find(x=>x.save)?.save;
  assert.ok(saved);
  assert.doesNotMatch(saved[2],/刚才的问题/,
   "verified recovery must use its neutral sequence rather than a one-time staff nudge");
  assert.match(saved[2],/护理|评估/);
  assert.equal(saved[8].mediaKey,null);
  assert.equal(saved[8].whatsappTemplate.recoveryNoSelection,true);
 }
});

test("131060 no-selection follow-ups require accepted recovery evidence in candidate and final recheck",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
   assert.match(sql,/recovery_menu\.id IS NOT NULL/);
   assert.match(sql,/recovery_menu\.at/);
   assert.match(sql,/recovery_evidence\.accepted=TRUE/);
   assert.match(sql,/recovery_evidence\.origin='system_fallback'/);
   assert.match(sql,/recovery_evidence\.provider_message_id=verified_recovery\.whatsapp_message_id/);
   assert.match(sql,/verified_recovery\.content LIKE 'Hi～欢迎来到 Neutro Sense/);
   assert.match(sql,/verified_recovery\.delivery_status IN \('sent','delivered','read'\)/);
   assert.match(sql,/verified_recovery_context\.conversation_id=sc\.id/);
   assert.match(sql,/newer_customer\.role='user'/);
   assert.match(sql,/inbound\.content LIKE '📎 \[% sent a WhatsApp message that could not be displayed\]'/);
   assert.match(sql,/whatsapp_opt_out_at IS NULL/);
   assert.match(sql,/c\.takeover_by IS NULL/);
   assert.match(sql,/latest_lead\.appointment_status|lead\.appointment_status/);
   assert.match(sql,/inbound\.created_at \+ INTERVAL '24 hours'/);
   assert.match(sql,/BETWEEN 7 AND 23/);
 }
 assert.match(worker.POTENTIAL_DUE_SQL,/recovery_evidence\.accepted=TRUE/);
 assert.match(worker.POTENTIAL_DUE_SQL,/recovery_menu\.at/);
 assert.match(worker.RECHECK_SQL,/recovery_menu\.id IS NOT NULL/);
 assert.match(worker.CANDIDATES_SQL,/readable_later\.content NOT LIKE/);
 assert.match(worker.CANDIDATES_SQL,/prior_recovery\.delivery_status IN/);
 assert.match(worker.RECHECK_SQL,/newer\.content NOT LIKE/);
});

test("a silent 131060 customer receives the text-only 2h, 6h and 20h reminders, never media or personalized sales",async()=>{
 const source="📎 [Customer sent a WhatsApp message that could not be displayed]";
 for(const slot of [2,6,20]){
   const recovery={...candidate,slot_hours:slot,recovery_no_selection:true,
     treatment_interest:"9D 逆龄抗衰",verified_treatment_name:"9D 逆龄抗衰",
     customer_texts:[source],first_reply_text:"Hi～欢迎来到 Neutro Sense 😊",
     media_key:"should-not-send.mp4",media_type:"video",media_mime_type:"video/mp4",
     media_filename:"should-not-send.mp4"};
   const f=fake({rows:[recovery]});
   const result=await worker.runOnce({...f,
     env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
       WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true"},
     storage:{downloadMedia:async()=>assert.fail("No recovery media")},
     videoSelection:()=>assert.fail("No recovery video selection"),
     personalize20h:()=>assert.fail("No 20h AI sales personalization"),
   });
   assert.equal(result.accepted,1,"slot "+slot);
   const save=f.calls.find(x=>x.save)?.save;
   const send=f.calls.find(x=>x.send)?.send;
   assert.ok(save && send);
   assert.match(save[2],/护理|评估/);
   assert.equal(save[8].mediaKey,null);
   assert.equal(save[8].whatsappTemplate.treatmentInterest,null,
     "old CRM treatment never becomes consent from an unreadable message");
   assert.equal(save[8].whatsappTemplate.recoveryNoSelection,true);
   assert.equal(send.dispatchTransport,undefined);
 }
});

test("Neutro 20h text-only follow-up does not request a six-day opt-in",async()=>{
 const envGeneral={...env,WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:"2026-11-12T07:00:00Z"};
 const row={...candidate,slot_hours:20,
  inbound_at:new Date("2026-11-12T07:01:00Z"),
  recovery_no_selection:true,lead_marketing_consent:"unknown",
  verified_meta_ad:true,customer_texts:["Hello, may I know more?"],
  first_reply_text:"Hello, welcome to Neutro Sense"};
 const f=fake({rows:[row]});
 const result=await worker.runOnce({...f,env:envGeneral,
  contacts:{getContactById:async()=>({...contact,whatsapp_sender_key:"neutro_secondary"})}});
 assert.equal(result.accepted,1);
 const saved=f.calls.find(x=>x.save).save;
 const sent=f.calls.find(x=>x.send).send;
 assert.equal(saved[8].whatsappTemplate.generalConsentButton,undefined);
 assert.equal(saved[8].whatsappTemplate.generalConsentLanguage,undefined);
 assert.doesNotMatch(saved[2],/我同意通过 WhatsApp 接收|I agree to receive WhatsApp follow-ups|若希望之后6天内继续收到/);
 assert.equal(sent.interactiveButtons,undefined);
 assert.equal(sent.dispatchTransport,undefined);
});

test("Neutro 6h approved treatment video keeps its media without an opt-in caption",async()=>{
 const envGeneral={...env,WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ENABLED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_BILLING_APPROVED:"true",
  WHATSAPP_SECONDARY_GENERAL_SIX_DAY_ACTIVATED_AT:"2026-11-12T07:00:00Z"};
 const row={...candidate,slot_hours:6,
  inbound_at:new Date("2026-11-12T07:01:00Z"),
  media_key:null,lead_marketing_consent:"unknown",
  verified_meta_ad:true,customer_texts:["骨盆调理多少钱"],
  treatment_interest:"骨盆调理"};
 const f=fake({rows:[row]});
 let mediaCalls=0;
 const result=await worker.runOnce({...f,env:envGeneral,
  contacts:{getContactById:async()=>({...contact,whatsapp_sender_key:"neutro_secondary"})},
  getConfig:()=>({services:[{name:"骨盆调理"}],
   automatedFollowUp:{additionalSteps:[{message:"请问您想了解骨盆调理吗？"}]}}),
  videoSelection:()=>({mediaKey:"approved-video",mediaType:"video",
   mediaMimeType:"video/mp4",mediaFilename:"clinic-followup.mp4"}),
  videoApproved:()=>true,
  storage:{downloadMedia:async()=>Buffer.from("approved video")},
  sendText:async payload=>{
   assert.equal(payload.interactiveButtons,undefined);
   assert.equal(typeof payload.dispatchTransport,"function");
   return payload.dispatchTransport({
    uploadMedia:async()=>({success:true,mediaId:"557"}),
    sendMediaById:async(type,id,options)=>{
     mediaCalls++;
     assert.equal(type,"video");assert.equal(id,"557");
     assert.doesNotMatch(options.caption,/我同意通过 WhatsApp 接收 Neutro Sense TCM/);
     assert.ok(Buffer.byteLength(options.caption,"utf8")<=1024);
     return{success:true,wamid:"wamid.secondary-consent-video"};
    },
   });
  },
 });
 assert.equal(result.accepted,1);
 assert.equal(mediaCalls,1);
 const saved=f.calls.find(x=>x.save).save;
 assert.equal(saved[8].whatsappTemplate.generalConsentButton,undefined);
 assert.doesNotMatch(saved[2],/我同意通过 WhatsApp 接收 Neutro Sense TCM/);
});

test("remote goodbye is respected at discovery and immediately before sending",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
  assert.match(sql,/closing_reply\.whatsapp_message_id IS NOT NULL/);
  assert.match(sql,/closing_reply\.delivery_status IN \('sent','delivered','read'\)/);
  assert.match(sql,/closing_reply\.sent_by_username IS NULL/);
  assert.match(sql,/closing_context\.conversation_id=sc\.id/);
  assert.match(sql,/柔佛\|新山\|johor/);
  assert.match(sql,/祝\(你\|您\)/);
  assert.match(sql,/closing_reply\.created_at,closing_reply\.id/);
  assert.match(sql,/NOT EXISTS\(\s*SELECT 1 FROM messages closing_reply/);
 }
 // Thanks alone and explicit distance objections remain separate hard stops.
 assert.match(worker.CANDIDATES_SQL,/谢谢\|謝謝/);
 assert.match(worker.RECHECK_SQL,/too\[\[:space:\]\]\+far/);
});

test("forwarded Before & After photos and routine staff messages do not stop secondary follow-ups",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
  assert.doesNotMatch(sql,/FROM messages human\s+WHERE human.contact_id=c.id/);
  assert.match(sql,/reply.sent_by_username IS NULL\) DESC/);
  assert.match(sql,/reply.is_forwarded,FALSE\)=FALSE/);
  assert.match(sql,/first_reply.staff_pending_action/);
  assert.match(sql,/c.mode='ai' AND c.takeover_by IS NULL/);
  assert.match(sql,/whatsapp_opt_out_at IS NULL/);
  assert.match(sql,/inbound.created_at \+ INTERVAL '24 hours'/);
 }
});

test("staff booking coordination still pauses follow-ups without marking an AI handoff",()=>{
 for(const sql of [worker.CANDIDATES_SQL,worker.RECHECK_SQL]){
  assert.match(sql,/appointment\[\[:space:\]\]/);
  assert.match(sql,/first_reply.staff_pending_action/);
  assert.match(sql,/first_reply.staff_question OR rule.slot_hours=2/);
  assert.match(sql,/reply.sent_by_username IS NOT NULL AND/);
  assert.match(sql,/reply.sent_by_username IS NULL\) DESC/);
 }
});

test("delivered staff video changes a service reminder to text-only, without cancelling it",async()=>{
 const f=fake({rows:[{...candidate,media_key:"approved-clinic-video",
   media_type:"video",media_mime_type:"video/mp4",media_filename:"clinic.mp4",
   staff_video_sent:true}]});
 const outcome=await worker.runOnce({...f,
  env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
  videoSelection:()=>assert.fail("another video must not be selected"),
  storage:{downloadMedia:async()=>assert.fail("another video must not be downloaded")},
 });
 assert.equal(outcome.accepted,1);
 assert.equal(f.sends,1);
 assert.equal(f.calls.find(x=>x.save).save[8].mediaKey,null);
});

test("a late staff video receipt blocks automatic video before outbound send",async()=>{
 const f=fake({rows:[{...candidate,media_key:"approved-clinic-video",
   media_type:"video",media_mime_type:"video/mp4",media_filename:"clinic.mp4",
   staff_video_sent:false}],staffVideoAllowed:false});
 const outcome=await worker.runOnce({...f,
  env:{...env,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
  videoApproved:()=>true,
  storage:{downloadMedia:async()=>Buffer.from("approved-video")},
 });
 assert.equal(outcome.accepted,0);
 assert.equal(f.sends,0);
 assert.equal(f.calls.some(x=>x.sql===worker.RECENT_STAFF_VIDEO_SQL),true);
 assert.equal(f.calls.some(x=>x.save),false);
});
