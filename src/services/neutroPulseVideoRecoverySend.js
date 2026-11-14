"use strict";

// Operator-authorized, single-purpose recovery of the 6h Pulse Wave video.
// This is a NEW message, not a retry of any previous Meta WAMID.
// Sends at most one new video per failed contact, and does not attempt the
// second recipient until the first has a verified delivered/read receipt.
// Peggy #9053 is excluded because her freeform window has expired.
const { pool } = require("../db/db");
const contactsRepo = require("../db/contactsRepo");
const messagesRepo = require("../db/messagesRepo");
const conversationStore = require("../utils/conversationStore");
const storage = require("./mediaStorageService");
const policy = require("./whatsappSecondaryPolicyService");
const { sendSecondaryStaffText } = require("./whatsappSecondaryStaffDispatch");
const { inspectMp4Codec } = require("./whatsappSecondaryVideoVerification");
const { isVerifiedFailedVideo } = require("./whatsappSecondaryVideoQuarantine");

const KEY = "clients/neutro-sense-tcm/messages/follow-up-config/pulse-wave-h264-aac-full-reencode-v1.mp4";
const CAPTION = "您好 😊 这是您之前咨询的黄金脉冲技术介绍视频。之前的视频发送时出现了格式问题，现在补发给您参考。如果想了解护理流程或预约评估，欢迎回复我们。";
const FILENAME = "pulse-wave-h264-aac.mp4";
const CONTACTS = Object.freeze([
  Object.freeze({id:9063,failedMessageId:19579}), // Cassey
  Object.freeze({id:9067,failedMessageId:19612}), // chungyewmoy
]);
const LOCK_A = 20261114, LOCK_B = 628;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));

function enabled(env=process.env){
  return env.NEUTRO_PULSE_RECOVERY_SEND_ENABLED === "true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "neutro_secondary" &&
    env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID === "1318355951360575" &&
    env.WHATSAPP_SECONDARY_WABA_ID === "1852014482431209" &&
    env.R2_BUCKET_NAME === "da-chatbot-neutro-sense-tcm-media" &&
    storage.getMediaIsolationStatus(env).prefix === "clients/neutro-sense-tcm";
}
function windowOpen(lastInbound,now=new Date()){
  const then=Date.parse(String(lastInbound||""));
  const current=now.getTime();
  // Match secondary policy's two-minute safety margin.
  return Number.isFinite(then)&&then<=current+120000 &&
    current+120000 < then+86400000;
}
async function currentStatus(id,{database=pool}={}){
  const r=await database.query(
    "SELECT id,delivery_status,whatsapp_message_id FROM messages " +
    "WHERE contact_id=$1 AND role='assistant' AND media_key=$2 " +
    "ORDER BY id ASC LIMIT 1",[id,KEY]);
  return r.rows[0]||null;
}
async function verifyRecipient({id,failedMessageId}, {
  database=pool,env=process.env,now=new Date()
}={}){
  const contact=await contactsRepo.getContactById(id);
  if(contact?.channel!=="whatsapp" ||
    String(contact.whatsapp_sender_id)!=="2" ||
    contact.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
    contact.mode!=="ai" || contact.takeover_by ||
    contact.whatsapp_opt_out_at) return {ok:false,code:"contact_no_longer_eligible"};
  const policyResult=await policy.previewSecondaryFreeformPolicy(contact,{
    database,env,now,purpose:"service"});
  if(policyResult?.policyAllowed!==true)
    return {ok:false,code:policyResult?.code||"reply_window_closed"};
  const recent=await database.query(
    "SELECT m.id,m.created_at,m.source_created_at " +
    "FROM messages m JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id " +
    "JOIN whatsapp_sender_conversations sc ON sc.id=mc.conversation_id " +
    "WHERE m.contact_id=$1 AND m.role='user' AND sc.sender_id=2 " +
    "AND sc.state='bound' AND m.whatsapp_message_id IS NOT NULL " +
    "ORDER BY COALESCE(m.source_created_at,m.created_at) DESC LIMIT 1",[id]);
  const inbound=recent.rows[0];
  if(!inbound || !windowOpen(inbound.source_created_at||inbound.created_at,now))
    return {ok:false,code:"no_recent_signed_customer_inbound"};
  const stage=await database.query(
    "SELECT appointment_status,is_closed FROM leads WHERE contact_id=$1 " +
    "ORDER BY is_closed ASC,created_at DESC,id DESC LIMIT 1",[id]);
  if(!stage.rows.length ||
    stage.rows[0].is_closed===true ||
    !["none","new",null].includes(stage.rows[0].appointment_status))
      return {ok:false,code:"appointment_or_lead_closed"};
  const failed=await database.query(
    "SELECT 1 FROM messages m " +
    "JOIN whatsapp_sender_billing_attempts a ON a.message_id=m.id " +
    "AND a.contact_id=m.contact_id AND a.sender_id=2 " +
    "AND a.wamid=m.whatsapp_message_id " +
    "JOIN whatsapp_sender_status_receipts r ON r.sender_id=a.sender_id " +
    "AND r.reservation_id=a.reservation_id AND r.wamid=a.wamid " +
    "AND r.matched=TRUE AND r.delivery_status='failed' " +
    "AND r.meta_phone_number_id=$3 AND r.meta_account_id=$4 " +
    "WHERE m.id=$1 AND m.contact_id=$2 AND m.media_mime_type='video/mp4' " +
    "AND m.delivery_status='failed' LIMIT 1",
    [failedMessageId,id,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
  if(failed.rows.length!==1)return {ok:false,code:"original_failure_unverified"};
  const outboundAfter=await database.query(
    "SELECT 1 FROM messages WHERE contact_id=$1 AND role='assistant' " +
    "AND id>$2 AND sent_by_username IS NOT NULL AND " +
    "delivery_status IN('sent','delivered','read') LIMIT 1",
    [id,failedMessageId]);
  if(outboundAfter.rows.length)return {ok:false,code:"newer_staff_message_sent"};
  return {ok:true,contact};
}
async function awaitDelivered(contactId,messageId,{database=pool}={}){
  // Never promote provider acceptance into delivery.
  for(let i=0;i<32;i++){
    const x=await database.query(
      "SELECT m.delivery_status, " +
      "EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts a " +
      "JOIN whatsapp_sender_status_receipts r ON r.sender_id=a.sender_id " +
      "AND r.reservation_id=a.reservation_id AND r.wamid=a.wamid " +
      "WHERE a.message_id=m.id AND a.contact_id=m.contact_id " +
      "AND r.matched=TRUE AND r.delivery_status IN('delivered','read') " +
      "AND r.meta_phone_number_id=$3 AND r.meta_account_id=$4) AS verified " +
      "FROM messages m WHERE m.id=$1 AND m.contact_id=$2",
      [messageId,contactId,process.env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
       process.env.WHATSAPP_SECONDARY_WABA_ID]);
    const status=x.rows[0];
    if(status?.verified===true &&
       ["delivered","read"].includes(status.delivery_status))
      return "confirmed_delivered";
    if(status?.delivery_status==="failed")return "confirmed_failed";
    await delay(2500);
  }
  return "delivery_not_confirmed";
}
async function dispatchForOne(entry,bytes,{database=pool,env=process.env}={}){
  let prior=await currentStatus(entry.id,{database});
  if(prior){
    const status=await awaitDelivered(entry.id,prior.id,{database});
    return {contactId:entry.id,messageId:prior.id,status,existing:true};
  }
  const check=await verifyRecipient(entry,{database,env});
  if(!check.ok)return {contactId:entry.id,status:"skipped",code:check.code};
  const saved=await conversationStore.appendMessageForContact(
    entry.id,"assistant",CAPTION,null,null,null,
    {mimeType:"video/mp4"},{mediaKey:KEY,mediaFilename:FILENAME}
  );
  // No duplicate writes on restart. A message saved before a provider send
  // remains a permanent one-shot claim, even if no WAMID was accepted.
  const preSendCheck=async()=>{
    const live=await verifyRecipient(entry,{database,env});
    return live.ok===true;
  };
  const outcome=await sendSecondaryStaffText({
    contact:check.contact,messageId:saved.id,text:CAPTION,
    origin:"staff",preSendCheck,
    dispatchTransport:async transport=>{
      const uploaded=await transport.uploadMedia(bytes,"video/mp4",FILENAME);
      if(uploaded?.success!==true||!uploaded.mediaId)return uploaded;
      if(!await preSendCheck())
        return {success:false,ambiguous:true,retryable:false};
      return transport.sendMediaById("video",uploaded.mediaId,{
        caption:CAPTION,filename:FILENAME});
    }
  },{database,env});
  if(outcome?.success===true && /^wamid\./.test(String(outcome.wamid||""))){
    await messagesRepo.setWhatsappMessageId(saved.id,outcome.wamid,{
      preserveVerifiedSecondaryReceipt:true});
    return {contactId:entry.id,messageId:saved.id,
      status:await awaitDelivered(entry.id,saved.id,{database})};
  }
  // Once attempted, do not retry even if Meta returned an uncertain result.
  const code=String(outcome?.code||"send_rejected").slice(0,120);
  if(outcome?.unknown===true || outcome?.ambiguous===true)
    await messagesRepo.setDeliveryStatusById(saved.id,"unknown",code);
  else await messagesRepo.setDeliveryStatusById(saved.id,"failed",code);
  return {contactId:entry.id,messageId:saved.id,
    status:outcome?.unknown?"delivery_not_confirmed":"send_blocked",code};
}
async function run({env=process.env,database=pool}={}){
  if(!enabled(env))return {status:"disabled"};
  const client=await database.connect();
  let locked=false;
  try{
    const claim=await client.query("SELECT pg_try_advisory_lock($1,$2) AS locked",
      [LOCK_A,LOCK_B]);
    locked=claim.rows[0]?.locked===true;
    if(!locked)return {status:"already_running"};
    const info=await storage.getSharedFollowUpMediaInfo(KEY);
    if(info?.bytes<300 || info.bytes>16*1024*1024 ||
       info.metadata?.reencoded!=="full-ffmpeg-h264-aac-v1" ||
       !/^[a-f0-9]{64}$/.test(String(info.metadata?.sha256||"")))
       return {status:"video_unverified"};
    const quarantined=await isVerifiedFailedVideo({database,senderId:2,mediaKey:KEY,env});
    if(quarantined)return {status:"new_video_quarantined"};
    const bytes=await storage.downloadMedia(KEY,{maxBytes:16*1024*1024});
    const verified=await inspectMp4Codec(bytes);
    if(!verified?.ok)return {status:"video_preflight_failed",code:verified.code};
    const results=[];
    for(const entry of CONTACTS){
      const outcome=await dispatchForOne(entry,bytes,{database,env});
      results.push(outcome);
      if(outcome.status!=="confirmed_delivered")break;
    }
    return {status:"completed",results};
  }catch(err){
    return {status:"error",code:String(err?.code||err?.name||"error").slice(0,100)};
  }finally{
    if(locked)await client.query("SELECT pg_advisory_unlock($1,$2)",
      [LOCK_A,LOCK_B]).catch(()=>{});
    client.release();
  }
}
module.exports={KEY,CAPTION,FILENAME,CONTACTS,enabled,windowOpen,run,
  verifyRecipient,dispatchForOne};
