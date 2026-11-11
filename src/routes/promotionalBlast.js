"use strict";
const express = require("express");
const { hasCapability } = require("../utils/permissions");
const blast = require("../services/promotionalBlastService");

const router = express.Router();

router.use((req,res,next)=>{
  if (req.user?.role !== "admin" ||
      !["manage_tools","view_all_leads","reply_to_assigned_leads"]
        .every(cap=>hasCapability(req.user,cap))) {
    return res.status(403).json({error:"An administrator with tools, all-lead viewing and reply access is required."});
  }
  res.set("Cache-Control","no-store");
  next();
});

router.get("/preview",async(req,res)=>{
  try {
    const rows = await blast.candidates();
    return res.json({
      campaignKey:blast.CAMPAIGN_KEY,
      campaignLabel:blast.CAMPAIGN_LABEL,
      templateName:blast.CAMPAIGN_KEY,
      recipients:rows.map(row=>({
        contactId:Number(row.contact_id),
        senderId:Number(row.sender_id),
        name:row.contact_name,
        treatmentInterest:row.treatment_interest,
        suggestedLanguage:row.suggested_language,
        expiresAt:row.safe_expires_at,
        blockedReason:row.blocked_reason,
        alreadyClaimed:row.already_claimed===true,
      })),
      checkedAt:new Date().toISOString(),
      possibleMetaCharges:true,
    });
  }catch(error){
    console.error("[Promotional blast] Preview unavailable:",error?.message);
    return res.status(503).json({error:"Could not verify current ad leads or billing evidence. No sends are authorized."});
  }
});

router.post("/claim",async(req,res)=>{
  const id=Number(req.body?.contactId);
  const language=String(req.body?.languageCode||"");
  if (!Number.isSafeInteger(id) || id<=0 ||
      !blast.LANGUAGES.has(language) ||
      req.body?.campaignKey!==blast.CAMPAIGN_KEY ||
      req.body?.billingAcknowledged!==true ||
      req.body?.marketingConsentReviewed!==true) {
    return res.status(400).json({
      error:"Choose an eligible contact and language, then confirm marketing consent and possible Meta charges."
    });
  }
  try{
    const claim=await blast.claimRecipient(id,language,req.session?.username);
    if (!claim) return res.status(409).json({
      code:"blast_recipient_unavailable",
      error:"Contact no longer qualifies, has an unresolved sender billing gate, or was already claimed. Refresh the preview. Do not retry an unknown send.",
    });
    return res.status(201).json({claimed:true,contactId:id,languageCode:language});
  }catch(error){
    console.error("[Promotional blast] Claim unavailable:",error?.message);
    return res.status(503).json({error:"Could not reserve this contact safely. No send was started."});
  }
});

module.exports=router;
