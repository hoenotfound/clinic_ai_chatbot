"use strict";
const express=require("express");
const {pool}=require("../db/db");
const configRepo=require("../db/configRepo");
const {listApprovedSecondaryMarketingTemplates}=require("../services/whatsappSecondaryMarketingTemplateCatalog");
const {enabled:marketingWorkerEnabled}=require("../services/whatsappSecondaryMarketingFollowUpService");
const {verifyApprovedVideo,listApprovedClinicVideos}=require("../services/whatsappSecondaryFollowUpVideoApproval");
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
      "SELECT slot_hours,enabled,message_text,media_key,media_key IS NOT NULL AS has_media,media_type,media_filename,updated_at " +
      "FROM whatsapp_sender_followup_rules WHERE sender_id=$1 ORDER BY slot_hours",
      [identity.id]
    );
    const marketing=await pool.query(
      "SELECT slot_hours,enabled,template_name,language_code,operator_billing_approved,updated_at "+
      "FROM whatsapp_sender_marketing_followup_rules WHERE sender_id=$1 ORDER BY slot_hours",
      [identity.id]);
    const templates=await listApprovedSecondaryMarketingTemplates({env:process.env})
      .catch(()=>null);
    return res.json({
      configured:true,senderDisplayName:identity.display_name,
      workerEnabled:process.env.WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED==="true",
      quietHours:{start:"00:00",end:"07:00"},
      mediaEnabled:process.env.WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED==="true" &&
        process.env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true",
      availableClinicVideos:listApprovedClinicVideos({
        env:process.env,clinicConfig:configRepo.getConfig(),
      }),
      rules:rules.rows,
      marketingRules:marketing.rows,
      marketingWorkerEnabled:marketingWorkerEnabled(process.env),
      marketingTemplates:templates||[],marketingCatalogAvailable:templates!==null,
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
      const approval=await verifyApprovedVideo({
        slot,mediaKey:req.body?.mediaKey,mediaType:req.body?.mediaType,
        confirmClinicVideoReuse:req.body?.confirmClinicVideoReuse,
        env:process.env,clinicConfig:configRepo.getConfig(),
      });
      if(!approval.approved)return res.status(409).json({
        code:approval.code,
        error:"This video is not an available, explicitly approved clinic follow-up asset for the secondary sender.",
      });
      mediaKey=approval.key;
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
// Explicit approval of a secondary-account Meta template and its charge
// occurs only here, under the same manage_tools permission as other rules.
// The scheduler is independently OFF even after a rule is saved as enabled.
router.put("/marketing/:slot",async(req,res)=>{
 try{
  const slot=Number(req.params.slot);
  if(![48,72].includes(slot))
   return res.status(400).json({error:"Only 48h and 72h marketing templates are supported."});
  const enabled=req.body?.enabled;
  const name=String(req.body?.templateName||"").trim();
  const languageCode=String(req.body?.languageCode||"").trim();
  if(typeof enabled!=="boolean" || !/^[a-z0-9_]{1,128}$/.test(name) ||
     !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode))
   return res.status(400).json({error:"Select an approved secondary-number marketing template."});
  if(enabled && req.body?.operatorBillingApproved!==true)
   return res.status(409).json({code:"secondary_marketing_charge_review_required",
    error:"Explicitly approve paid marketing-template charges for this secondary number."});
  const identity=await sender(pool,process.env);
  if(!identity)return res.status(409).json({code:"secondary_sender_not_activated"});
  const available=await listApprovedSecondaryMarketingTemplates({env:process.env});
  const approved=available.find(t=>t.name===name && t.languageCode===languageCode);
  if(!approved)return res.status(409).json({
   code:"secondary_marketing_template_not_approved",
   error:"The selected text-only marketing template is not APPROVED on the second account.",
  });
  const saved=await pool.query(
   `INSERT INTO whatsapp_sender_marketing_followup_rules
      (sender_id,slot_hours,enabled,template_name,language_code,
       template_signature,operator_billing_approved,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT(sender_id,slot_hours) DO UPDATE SET
       enabled=EXCLUDED.enabled,template_name=EXCLUDED.template_name,
       language_code=EXCLUDED.language_code,
       template_signature=EXCLUDED.template_signature,
       operator_billing_approved=EXCLUDED.operator_billing_approved,
       updated_at=NOW()
     RETURNING slot_hours,enabled,template_name,language_code,operator_billing_approved,updated_at`,
   [identity.id,slot,enabled,name,languageCode,approved.signature,
    enabled && req.body.operatorBillingApproved===true]);
  res.set("Cache-Control","no-store");
  return res.json({saved:true,rule:saved.rows[0],
   marketingWorkerEnabled:marketingWorkerEnabled(process.env)});
 }catch{
  return res.status(503).json({
   error:"Second-number template approval or rule configuration could not be verified.",
  });
 }
});
module.exports=router;
