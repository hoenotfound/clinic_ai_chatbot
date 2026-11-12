"use strict";

// Staff may upload the same promotional image under a completely different R2
// key. URL/path matching cannot prove what those pixels contain. Reuse the
// existing strong caption match to identify a confirmed duplicate, and send
// uncertain cases to staff instead of assuming either "already sent" or "safe".
const {sameManuallyUploadedPromotionCaption}=require("./promotionManualMediaIdentity");
const {imageIdentity}=require("./pricingReminderSelection");

function imageReview(offers,rows,{inboundAt}={}){
  if(!Array.isArray(offers)||!offers.length||!Array.isArray(rows)||!rows.length)
    return {action:"clear"};
  const start=Date.parse(inboundAt);
  for(const media of rows){
    const status=String(media.delivery_status||"").toLowerCase();
    if(["failed","cancelled"].includes(status))continue;
    const hasProvider=/^wamid\./.test(String(media.whatsapp_message_id||""));
    const confirmed=hasProvider&&(
      ["sent","delivered","read"].includes(status)||
      (status==="pending"&&Boolean(media.whatsapp_accepted_at))||
      (!status && String(media.sent_by_username||"").toLowerCase()==="whatsapp business app"));
    const storedPath=imageIdentity(media.media_url);
    if(storedPath&&offers.some(offer=>(offer.identities||[]).includes(storedPath)))
      continue; // already handled by the existing delivered/unknown selector
    const caption=String(media.content||"").trim();
    const stronglyMatched=offers.some(offer=>
      sameManuallyUploadedPromotionCaption(offer.caption,caption));
    if(stronglyMatched)
      return {action:confirmed?"already_sent_manually":"review",reason:confirmed?
        "manual_pricing_confirmed":"manual_pricing_delivery_unverified"};
    const imageAt=Date.parse(media.created_at);
    // An old, unrelated image must not block the new enquiry. Captionless
    // images from this session cannot be classified from their URL or key.
    const recent=Number.isFinite(start)&&Number.isFinite(imageAt)&&
      imageAt>=start-24*3600000;
    if(!recent)continue;
    const pricingText=/(?:RM|MYR)\s*\d{2,5}|(?:价钱|價格|价格|優惠|优惠|配套|套餐|promo|price|pricing|package|harga|pakej)/iu.test(caption);
    const looksLikeService=offers.some(offer=>
      String(offer.serviceName||"").length>=2 &&
      caption.toLowerCase().includes(String(offer.serviceName).toLowerCase()));
    if(!caption||pricingText||looksLikeService){
      return {action:"review",reason:confirmed?"manual_image_identity_unverified":
        "manual_image_delivery_unverified"};
    }
  }
  return {action:"clear"};
}

module.exports={imageReview};
