"use strict";
const express=require("express");
const {pool}=require("../db/db");
const configRepo=require("../db/configRepo");
const mediaStorage=require("../services/mediaStorageService");
const {hasCapability}=require("../utils/permissions");
const router=express.Router();
const SLOTS=new Set([2,6,20]);
function allowed(req,res,next){
  if(!hasCapability(req.user,"manage_tools")){
    return res.status(403).json({error:"Manage Tools permission is required."});
  }
  next();
}
router.use(allowed);
function ready(env){
  return env.WHATSAPP_MULTI_NUMBER_READ_ENABLED==="true" &&
    env.WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED==="true" &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"")) &&
    /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID||"")) &&
    typeof env.WHATSAPP_SECONDARY_SENDER_KEY==="string";
}
async function sender(database,env){
  if(!ready(env))return null;
  const r=await database.query(
    "SELECT id,display_name FROM whatsapp_sender_accounts " +
    "WHERE sender_key=$1 AND meta_phone_number_id=$2 " +
    "AND meta_account_id=$3 AND state='active'",
    [env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
      env.WHATSAPP_SECONDARY_WABA_ID]
  );
  return r.rows?.length===1?r.rows[0]:null;
}
router.get("/",async(req,res)=>{
  try {
    const identity=await sender(pool,process.env);
    res.set("Cache-Control","no-store");
    if(!identity)return res.json({configured:false,workerEnabled:false,
      rules:[],quietHours:{start:"00:00",end:"07:00"}});
    const rules=await pool.query(
      "SELECT slot_hours,enabled,message_text,media_key IS NOT NULL AS has_media,media_type,media_filename,updated_at " +
      "FROM whatsapp_sender_followup_rules WHERE sender_id=$1 ORDER BY slot_hours",
      [identity.id]
    );
    return res.json({
      configured:true,senderDisplayName:identity.display_name,
      workerEnabled:process.env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true",
      quietHours:{start:"00:00",end:"07:00"},
      rules:rules.rows,
    });
  }catch(err){
    console.error("Sender-specific followup config failed:",err);
    return res.status(503).json({error:"Secondary WhatsApp follow-up rules unavailable."});
  }
});
router.put("/:slot",async(req,res)=>{
  try {
    const slot=Number(req.params.slot);
    if(!SLOTS.has(slot))return res.status(400).json({error:"Only 2, 6 and 20 hour follow-ups are supported."});
    const text=typeof req.body?.messageText==="string"?req.body.messageText.trim():"";
    const enabled=req.body?.enabled;
    if(typeof enabled!=="boolean" || text.length<3 || text.length>1024 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      return res.status(400).json({error:"Provide a reviewed message of 3–1024 characters and a valid enabled setting."});
    }
    // Reuse only a pre-existing Neutro-clinic follow-up video object,
    // never a customer attachment or a primary Meta media ID. Both numbers
    // may share approved clinic creative content, but NOT provider credentials,
    // provider media IDs, billing or recipient identity.
    const wantsMedia=Boolean(req.body?.mediaKey || req.body?.mediaType);
    let mediaKey=null;
    if(wantsMedia){
      const key=String(req.body?.mediaKey||"").trim();
      const approved=process.env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED==="true" &&
        process.env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" &&
        process.env.WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED==="true" &&
        process.env.WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE==="primary" &&
        req.body?.confirmClinicVideoReuse===true &&
        (slot===2 || slot===6) &&
        req.body.mediaType==="video" &&
        mediaStorage.isReferencedClinicFollowUpMediaKey(
          key,configRepo.getConfig(),process.env);
      if(!approved)return res.status(409).json({
        code:"secondary_followup_media_not_authorized",
        error:"Choose an existing approved clinic follow-up video and explicitly approve its use on the second WhatsApp.",
      });
      try{
        const info=await mediaStorage.getSharedFollowUpMediaInfo(key);
        if(info.mimeType!=="video/mp4" || !Number.isSafeInteger(info.bytes) ||
           info.bytes<=0 || info.bytes>16*1024*1024) {
          return res.status(409).json({code:"secondary_followup_video_invalid",
            error:"Approved clinic video must be an existing MP4 under 16 MB."});
        }
      }catch{
        return res.status(409).json({code:"secondary_followup_video_unavailable",
          error:"Approved clinic video is not available in storage."});
      }
      mediaKey=key;
    }
    const identity=await sender(pool,process.env);
    if(!identity)return res.status(409).json({
      code:"secondary_sender_not_activated",
      error:"The verified secondary sender must be registered before saving follow-ups.",
    });
    const updated=await pool.query(
      `INSERT INTO whatsapp_sender_followup_rules
         (sender_id,slot_hours,enabled,message_text,
          media_key,media_type,media_mime_type,media_filename,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT(sender_id,slot_hours) DO UPDATE SET
         enabled=EXCLUDED.enabled,message_text=EXCLUDED.message_text,
         media_key=EXCLUDED.media_key,media_type=EXCLUDED.media_type,
         media_mime_type=EXCLUDED.media_mime_type,
         media_filename=EXCLUDED.media_filename,updated_at=NOW()
       RETURNING slot_hours,enabled,message_text,
          media_key IS NOT NULL AS has_media,media_type,media_filename,updated_at`,
      [identity.id,slot,enabled,text,mediaKey,mediaKey?"video":null,
       mediaKey?"video/mp4":null,mediaKey?"clinic-followup.mp4":null]
    );
    res.set("Cache-Control","no-store");
    return res.json({saved:true,rule:updated.rows[0],
      workerEnabled:process.env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true"});
  }catch(err) {
    console.error("Unable to save Secondary WhatsApp follow-up rule:",err);
    return res.status(503).json({error:"Could not save the verified Secondary WhatsApp follow-up configuration."});
  }
});
module.exports=router;
