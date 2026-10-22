"use strict";
const express=require("express");
const {pool}=require("../db/db");
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
      "SELECT slot_hours,enabled,message_text,media_type,media_filename,updated_at " +
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
    return res.status(503).json({error:"Ariel follow-up rules unavailable."});
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
    if(req.body?.mediaKey||req.body?.mediaType){
      return res.status(409).json({
        code:"secondary_followup_media_configuration_not_available",
        error:"Ariel follow-up media cannot reuse Neutro assets. Use a sender-approved attachment flow.",
      });
    }
    const identity=await sender(pool,process.env);
    if(!identity)return res.status(409).json({
      code:"secondary_sender_not_activated",
      error:"The verified Ariel sender must be registered before saving follow-ups.",
    });
    const updated=await pool.query(
      `INSERT INTO whatsapp_sender_followup_rules
         (sender_id,slot_hours,enabled,message_text,updated_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(sender_id,slot_hours) DO UPDATE SET
         enabled=EXCLUDED.enabled,message_text=EXCLUDED.message_text,
         media_key=NULL,media_type=NULL,media_mime_type=NULL,media_filename=NULL,
         updated_at=NOW()
       RETURNING slot_hours,enabled,message_text,updated_at`,
      [identity.id,slot,enabled,text]
    );
    res.set("Cache-Control","no-store");
    return res.json({saved:true,rule:updated.rows[0],
      workerEnabled:process.env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true"});
  }catch(err) {
    console.error("Unable to save Ariel follow-up rule:",err);
    return res.status(503).json({error:"Could not save the verified Ariel follow-up configuration."});
  }
});
module.exports=router;
