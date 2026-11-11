"use strict";
const express=require("express");
const { hasCapability }=require("../utils/permissions");
const blast=require("../services/promotionalBlastService");
const router=express.Router();

router.use((req,res,next)=>{
  if(req.user?.role!=="admin"||
    !["manage_tools","view_all_leads","reply_to_assigned_leads"]
      .every(cap=>hasCapability(req.user,cap))) {
    return res.status(403).json({error:"Administrator access to all leads, tools and replies is required."});
  }
  res.set("Cache-Control","no-store");
  next();
});

router.get("/campaigns",async(req,res)=>{
  try{
    const campaigns=await blast.listCampaigns();
    return res.json({campaigns:campaigns.map(row=>({
      campaignKey:row.campaign_key,templateName:row.template_name,title:row.title,
      promotedTreatment:row.promoted_treatment,targetTreatments:row.target_treatments,
      validUntil:row.valid_until,enabled:row.enabled,
    }))});
  }catch(error){
    console.error("[Promotional blast] Campaign list unavailable:",error?.message);
    return res.status(503).json({error:"Could not load promotional campaigns."});
  }
});

router.post("/campaigns",async(req,res)=>{
  try{
    const record=await blast.createCampaign(req.body,req.session?.username);
    if(!record)return res.status(400).json({
      error:"Invalid campaign. Supply a unique lowercase key, a MARKETING template name, a title, a promoted treatment, target treatments and a deadline within 90 days.",
    });
    return res.status(201).json({
      campaignKey:record.campaign_key,templateName:record.template_name,title:record.title,
      promotedTreatment:record.promoted_treatment,targetTreatments:record.target_treatments,
      validUntil:record.valid_until,enabled:record.enabled,
    });
  }catch(error){
    console.error("[Promotional blast] Campaign creation unavailable:",error?.message);
    return res.status(503).json({error:"Could not create a promotional campaign."});
  }
});

router.get("/preview",async(req,res)=>{
  const key=blast.validKey(req.query?.campaign);
  if(!key)return res.status(400).json({error:"Select a registered promotional campaign."});
  try{
    const campaign=await blast.getCampaign(key);
    if(!campaign||campaign.enabled!==true||new Date(campaign.valid_until).getTime()<=Date.now()){
      return res.status(409).json({error:"This campaign is disabled or has ended."});
    }
    const rows=await blast.candidates(key);
    return res.json({
      campaignKey:key,campaignLabel:campaign.title,templateName:campaign.template_name,
      promotedTreatment:campaign.promoted_treatment,validUntil:campaign.valid_until,
      recipients:rows.map(row=>({
        contactId:Number(row.contact_id),senderId:Number(row.sender_id),
        name:row.contact_name,treatmentInterest:row.treatment_interest,
        relatedOfferReviewRequired:row.related_offer_review_required===true,
        suggestedLanguage:row.suggested_language,expiresAt:row.safe_expires_at,
        blockedReason:row.blocked_reason,alreadyClaimed:row.already_claimed===true,
      })),
      checkedAt:new Date().toISOString(),possibleMetaCharges:true,
    });
  }catch(error){
    console.error("[Promotional blast] Preview unavailable:",error?.message);
    return res.status(503).json({error:"Could not verify current ad leads or billing evidence. No sends are authorized."});
  }
});

router.post("/claim",async(req,res)=>{
  const id=Number(req.body?.contactId);
  const lang=String(req.body?.languageCode||"");
  const key=blast.validKey(req.body?.campaignKey);
  if(!key||!Number.isSafeInteger(id)||id<1||!blast.LANGUAGES.has(lang)||
    req.body?.billingAcknowledged!==true||req.body?.marketingConsentReviewed!==true) {
    return res.status(400).json({
      error:"Choose an eligible contact, review the marketing consent and acknowledge possible Meta charges.",
    });
  }
  try{
    const claim=await blast.claimRecipient(id,lang,req.session?.username,{
      campaign:key,relatedOfferReviewed:req.body?.relatedOfferReviewed===true,
    });
    if(!claim)return res.status(409).json({
      code:"blast_recipient_unavailable",
      error:"Recipient no longer qualifies, is currently reserved, or requires a related-offer consent review. Refresh the preview.",
    });
    return res.status(201).json({
      claimed:true,campaignKey:key,contactId:id,languageCode:lang,
      reservationToken:claim.reservation_token,
    });
  }catch(error){
    console.error("[Promotional blast] Claim unavailable:",error?.message);
    return res.status(503).json({error:"Could not reserve this contact safely. No message was started."});
  }
});
module.exports=router;
