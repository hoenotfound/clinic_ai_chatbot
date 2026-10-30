"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  adsOnlyActivation, adsOnlyEligibleSql, isSecondaryAdsOnlyEligible,
  eligibleSecondaryAdsOnlyContactIds,
} = require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const { sendSecondaryStaffText } = require("../src/services/whatsappSecondaryStaffDispatch");
const followups = require("../src/services/whatsappSecondaryFollowUpService");
const media = require("../src/services/whatsappSecondaryAiMediaQueue");

const env = {
  WHATSAPP_SECONDARY_SENDER_KEY: "neutro_secondary",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED: "true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED: "true",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE: "ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT: "2026-10-30T03:00:00Z",
};

test("ads-only audience fails closed without a UTC activation cutoff", () => {
  assert.equal(adsOnlyActivation({}), null);
  assert.equal(adsOnlyActivation({...env, WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all"}), null);
  assert.equal(adsOnlyActivation({...env, WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30"}), null);
  assert.equal(adsOnlyActivation({...env, WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"bogus"}), null);
  assert.equal(adsOnlyActivation(env), "2026-10-30T03:00:00.000Z");
});

test("eligibility relies on sender-bound first provider inbound with actual Meta ad evidence", async () => {
  const expected = adsOnlyEligibleSql("c", "$2");
  for (const match of [
    "ads_sa.sender_key='neutro_secondary'",
    "ads_sc.state='bound'",
    "ads_context.conversation_id=ads_sc.id",
    "whatsapp_free_entry_referrals ads_ref",
    "ads_ref.source_type='ad'",
    "ads_ref.meta_ad_id",
    "ads_ref.ctwa_clid",
    "ads_first.whatsapp_message_id IS NOT NULL",
    "c.created_at >= $2::timestamptz",
    "ads_first.created_at >= $2::timestamptz",
    "earlier_clinic_contact.created_at < c.created_at",
    "earlier_clinic_contact.whatsapp_number IN",
    "primary_sender.sender_key='neutro'",
    "FROM messages ads_prior",
    "whatsapp_sender_coexistence_history_messages ads_import",
  ]) assert.ok(expected.includes(match), match);
  let queries = 0;
  const database = {query:async(sql,params)=>{
    queries++;
    assert.ok(sql.includes(expected));
    assert.deepEqual(params,[21,"2026-10-30T03:00:00.000Z"]);
    return {rows:[{eligible:true}]};
  }};
  assert.equal(await isSecondaryAdsOnlyEligible(21,{database,env}),true);
  assert.equal(queries,1);
  assert.equal(await isSecondaryAdsOnlyEligible(21,{database,env:{}}),false);
  assert.equal(queries,1);
  assert.equal(await isSecondaryAdsOnlyEligible("invalid",{database,env}),false);
  assert.equal(queries,1);
});

test("missing referral/DB error cannot authorize secondary automation",async()=>{
  const denied = {query:async()=>({rows:[{eligible:false}]})};
  assert.equal(await isSecondaryAdsOnlyEligible(8,{database:denied,env}),false);
  const broken = {query:async()=>{throw Error("simulated database unavailable")}};
  assert.equal(await isSecondaryAdsOnlyEligible(8,{database:broken,env}),false);
});

test("all secondary automated media and 2/6/20h followup selectors use shared first-ad SQL",()=>{
  for(const sql of [followups.CANDIDATES_SQL,followups.RECHECK_SQL,
    media.READY_SQL,media.STILL_VALID_SQL]){
    assert.match(sql,/whatsapp_free_entry_referrals ads_ref/);
    assert.match(sql,/whatsapp_sender_coexistence_history_messages ads_import/);
    assert.match(sql,/ads_sa.sender_key='neutro_secondary'/);
  }
  assert.equal(followups.start({env:{},setIntervalFn:()=>assert.fail()}),false);
  assert.equal(media.start({env:{},setIntervalFn:()=>assert.fail()}),false);
});

test("automated send to manual existing contact is stopped before policy or billing",async()=>{
  let providerCalls=0;
  const result=await sendSecondaryStaffText({
    contact:{id:21,channel:"whatsapp",whatsapp_number:"60122220000"},
    messageId:52,text:"AI hello",origin:"ai_reply",
  },{
    env:{
      ...env,
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
      WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
      WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
      WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      WHATSAPP_COEXISTENCE_ENABLED:"true",
      WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
      WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
      WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
      WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
      WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
      WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
      WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
      WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
    },
    audienceEligible:async()=>false,
    database:{query:async()=>{providerCalls++;throw Error("Do not query billing")}},
    billingRepo:{reserveSecondaryBillingAttempt:async()=>{providerCalls++;throw Error("Do not reserve")}},
    createTransport:async()=>{providerCalls++;throw Error("Do not call Meta")},
  });
  assert.equal(result.code,"secondary_ads_only_contact_ineligible");
  assert.equal(providerCalls,0);
});

// The secondary manual-audio path must remain a terminal staff-only path.
// Without this guard the voice placeholder would be overwritten as "🎤 null".
test("manual secondary voice messages retain the staff label and bypass AI transcription",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const voice=source.slice(source.indexOf('if (mediaType === "audio")'),
    source.indexOf('if (mediaType === "image")'));
  assert.ok(voice.includes('secondaryInboxOnly ? null : transcribeAudio('));
  const manual=voice.slice(voice.indexOf('if (secondaryInboxOnly) {'),
    voice.indexOf('} else if (!transcript)'));
  assert.ok(manual.includes('"🎤 [Voice message for staff]"'));
  assert.match(manual,/return\s+\{\s*wasFirstMessage,\s*keywordReason\s*\}/);
});


test("manual secondary unsupported, failed image/video stay unread without AI-review Telegram",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const block=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to));
  const unsupported=block("if (unsupportedType) {","let text = incoming.text");
  assert.match(unsupported,/if \(!secondaryInboxOnly\) \{[\s\S]*?setAiReviewAttention/);
  assert.match(unsupported,/return \{ wasFirstMessage, keywordReason \}/);
  for(const [from,to] of [
    ['if (mediaType === "image")','if (mediaType === "video")'],
    ['if (mediaType === "video")','if (mediaType === "sticker")']
  ]){
    const media=block(from,to);
    assert.match(media,/if \(!secondaryInboxOnly\) \{\s*await contactsRepo\.setAiReviewAttention/);
  }
  const handoff=block("// Preserve incoming secondary media before handing the turn to staff.",
    "// Photos/videos without captions and stickers");
  assert.match(handoff,/if \(secondaryInboxOnly\) \{[\s\S]*?return \{ wasFirstMessage, keywordReason \}/);
  assert.doesNotMatch(handoff,/setAttention\(|setAiReviewAttention\(/);
});

test("Inbox batch does not query Neon unless secondary ads-only AI is operational",async()=>{
  let queries=0;
  const database={query:async(sql,args)=>{
    queries++;
    assert.match(sql,/earlier_clinic_contact/);
    assert.deepEqual(args,[[11,12],"2026-10-30T03:00:00.000Z"]);
    return {rows:[{id:11}]};
  }};
  const off=await eligibleSecondaryAdsOnlyContactIds([11,12],{
    database,env:{...env,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"}
  });
  assert.deepEqual([...off],[]);
  assert.equal(queries,0);
  const enabled={...env,WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"};
  assert.deepEqual([...await eligibleSecondaryAdsOnlyContactIds([11,12],{database,env:enabled})],[11]);
  assert.equal(queries,1,"one batched lookup, never one query per contact");
});

test("single-contact audience checks do not query Neon until both secondary AI gates open",async()=>{
  let calls=0;
  const database={query:async()=>{calls++;return {rows:[{eligible:true}]};}};
  for(const flags of [
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false"},
    {WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"false",WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"}
  ]){
    assert.equal(await isSecondaryAdsOnlyEligible(14,{database,env:{...env,...flags}}),false);
  }
  assert.equal(calls,0,"no per-message eligibility SQL for disabled automation");
  assert.equal(await isSecondaryAdsOnlyEligible(14,{database,env}),true);
  assert.equal(calls,1);
});

// Exercise the real server.js incoming-message handler with isolated external
// dependencies. This executes the actual catch branch, rather than merely
// checking source text for the presence of a conditional.
function realIncomingHandlerForManualMedia({
  senderKey="neutro_secondary",mediaType="image",operation="store",
  aiEnabled=false,
}={}){
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const start=source.indexOf("async function processIncomingMessage(");
  const stop=source.indexOf("// Runtime secret checks",start);
  assert.ok(start>0 && stop>start);
  const results={reviews:[],temporaryReviews:[],stored:0,eligibilityQueries:0,
    outbound:0,errors:[],downloads:0};
  const context={
    console:{error:(...parts)=>results.errors.push(parts.join(" ")),warn:()=>{},log:()=>{}},
    process:{env:{
      WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
      WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
      WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
      WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:aiEnabled?"true":"false",
      WHATSAPP_SECONDARY_AI_SEND_ENABLED:aiEnabled?"true":"false",
    }},
    Buffer,clinicConfig:{},getOperationalLabels:()=>({
      customerLabel:"customer",customerSingular:"customer"
    }),
    secondaryUsesPrimaryClinicContent:()=>true,
    isSecondaryAdsOnlyEligible:async()=>{results.eligibilityQueries++;return false;},
    aiReplyCancellation:{
      keyForWhatsAppNumber:()=> "test-sender-key",
      snapshot:()=>0,
      safeToSend:()=>true,
    },
    channelMessaging:{
      downloadIncomingMedia:async()=>{
        results.downloads++;
        if(operation==="download")throw Error("simulated provider media download failure");
        return {mimeType:mediaType==="audio"?"audio/ogg":"image/jpeg",
          buffer:Buffer.from("test-media")};
      },
    },
    convertToMp3:async()=>null,
    transcribeAudio:async()=>{throw Error("manual audio must not transcribe");},
    conversationStore:{
      updateInboundMessage:async()=>{
        results.stored++;
        if(operation==="store")throw Error("simulated R2 media upload failure");
      }
    },
    contactsRepo:{
      setAiReviewAttention:async(...args)=>{results.reviews.push(args);},
      setTemporaryAiAttention:async(...args)=>{results.temporaryReviews.push(args);},
    },
    ai:{isRecoverableAiReplyFailure:()=>false},
  };
  const receive=vm.runInNewContext(source.slice(start,stop)+"\nprocessIncomingMessage;",context,{
    filename:"src/server.js"
  });
  const item={
    incoming:{id:"wamid.manual-media-1",from:"60120009999",channel:"whatsapp",
      mediaType,mediaId:"meta-media-1",text:"Please check this"},
    contact:{id:41,mode:"ai",channel:"whatsapp",whatsapp_number:"60120009999",
      whatsapp_sender_key:senderKey,whatsapp_sender_id:senderKey==="neutro_secondary"?2:1},
    savedInbound:{id:55,contact_id:41,role:"user",content:"durable placeholder"},
    processingJobId:77,
  };
  return {results,run:()=>receive(item)};
}

test("real manual secondary image storage failure stays Inbox-only and never creates AI/Telegram review",async()=>{
  const {run,results}=realIncomingHandlerForManualMedia({mediaType:"image"});
  await run();
  assert.equal(results.stored,1,"the real media storage failure was exercised");
  assert.equal(results.downloads,1);
  assert.equal(results.eligibilityQueries,0,"secondary AI OFF means no eligibility SQL path");
  assert.equal(results.reviews.length,0);
  assert.equal(results.temporaryReviews.length,0);
  assert.equal(results.outbound,0);
  assert.match(results.errors.join(" " ),/simulated R2 media upload failure/);
});

test("real manual secondary voice and provider download exceptions never enter AI attention",async()=>{
  for(const variant of [
    {mediaType:"audio",operation:"store"},
    {mediaType:"image",operation:"download"}
  ]){
    const {run,results}=realIncomingHandlerForManualMedia(variant);
    await run();
    assert.equal(results.reviews.length,0,JSON.stringify(variant));
    assert.equal(results.temporaryReviews.length,0,JSON.stringify(variant));
    assert.equal(results.eligibilityQueries,0,JSON.stringify(variant));
    assert.ok(results.errors.length>0,JSON.stringify(variant));
  }
});

test("existing primary WhatsApp media failure still produces staff AI-review attention",async()=>{
  const {run,results}=realIncomingHandlerForManualMedia({senderKey:"neutro",mediaType:"image"});
  await run();
  assert.equal(results.stored,1);
  assert.equal(results.reviews.length,1,"primary handling must not be muted");
  assert.equal(results.eligibilityQueries,0);
});

test("enabled secondary audience still verifies eligibility, but ineligible contacts stay manual",async()=>{
  const {run,results}=realIncomingHandlerForManualMedia({aiEnabled:true});
  await run();
  assert.equal(results.eligibilityQueries,1);
  assert.equal(results.reviews.length,0);
});
