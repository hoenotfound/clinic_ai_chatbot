const { hasCustomerPriceEnquiry } = require("./customerEnquiryEvidence");

// A price question on its own is not evidence that the customer also asked
// for treatment results. Recognize a separate, explicit treatment enquiry in
// the customer's own current message, not a model flag or an ad name.
const EXPLICIT_TREATMENT_INTEREST = /(?:想了解|想知道|想咨询|想諮詢|想做|我对|我對|对.*有兴趣|對.*有興趣|感兴趣|感興趣|了解一下|想看看|想看|想改善|想试|想試|想预约|想預約|interested in|want to (?:know|learn|try|do)|would like to (?:know|learn|try|do)|tell me (?:more )?about|learn more about|enquir(?:y|e) about|berminat (?:dengan|untuk)|nak (?:tahu|cuba|buat)|mahu (?:tahu|cuba|buat))(?:(?![。.!?？]).){0,95}(?:骨盆|整骨|调理|調理|疗程|療程|小颜|小顏|逆龄|逆齡|面部|脸型|臉型|体态|體態|治疗|治療|treatment|pelvi[cs]|postpartum|facial|hifu|3d|9d|rawatan)|(?:骨盆|整骨|调理|調理|疗程|療程|小颜|小顏|逆龄|逆齡|面部|脸型|臉型|体态|體態|治疗|治療|treatment|pelvi[cs]|postpartum|facial|hifu|3d|9d|rawatan)(?:(?![。.!?？]).){0,95}(?:想了解|想知道|想做|感兴趣|感興趣|有兴趣|有興趣|interested|want to (?:know|learn|try|do)|would like to (?:know|learn|try|do)|berminat)/iu;

// Explicit result requests are not the same as price enquiries, and should
// still be considered when proof is configured and independently eligible.
const EXPLICIT_RESULT_IMAGE_REQUEST = /(?:效果[图圖]|对比[图圖]|對比[圖图]|前后对比|前後對比|案例[图圖照片]|真人案例|顾客案例|顧客案例|看.*(?:效果|案例|对比|對比)|before[\s-]*(?:and|&|after)[\s-]*after?|before[\s&/-]*after|result\s*(?:photos?|pictures?|images?)|photos?\s+of\s+(?:results?|before)|see\s+(?:the\s+)?(?:results?|photos?|pictures?))/iu;

// Keep optional provider sends short. Two promotion graphics leave room for
// one result example, not a four-image burst. No extra media are queued:
// every later turn must still pass the normal eligibility and duplicate gates.
const MAX_AUTOMATIC_IMAGES_PER_REPLY = 3;
const RESULT_MEDIA_SEND_SPACING_MS = 1000;

function planPromotionMediaPacing(packages = []) {
  const items = Array.isArray(packages) ? packages : [];
  return {
    items: items.slice(0, MAX_AUTOMATIC_IMAGES_PER_REPLY),
    reason: items.length > MAX_AUTOMATIC_IMAGES_PER_REPLY
      ? "promotion_image_budget" : null,
  };
}

function planResultMediaPacing({
  customerText, promotionCount = 0, items = [], allowRelatedPriceProof = false,
  completedPriceClarification = false,
} = {}) {
  const promotions = Number.isSafeInteger(promotionCount)
    ? Math.max(0, promotionCount)
    : 0;
  const results = Array.isArray(items) ? items : [];
  if (!results.length) return { items: [], reason: "no_eligible_result_media" };

  // When a customer answers our "Which treatment price?" question with just
  // "骨盆", the present message alone no longer looks like a price question.
  // Keep the same price-first pacing as their original enquiry, rather than
  // adding a Before & After image after both promotional price graphics.
  if ((hasCustomerPriceEnquiry(customerText) || completedPriceClarification === true) &&
      !EXPLICIT_TREATMENT_INTEREST.test(String(customerText || "")) &&
      !EXPLICIT_RESULT_IMAGE_REQUEST.test(String(customerText || "")) &&
      !(allowRelatedPriceProof === true && promotions === 0 && completedPriceClarification !== true)) {
    return { items: [], reason: "promotion_price_priority" };
  }

  const remaining = Math.max(0, MAX_AUTOMATIC_IMAGES_PER_REPLY - promotions);
  if (!remaining) return { items: [], reason: "promotion_image_budget" };

  const selected = results.slice(0, remaining);
  return {
    items: selected,
    reason: selected.length < results.length ? "result_media_paced_after_promotions" : null,
  };
}

module.exports = {
  EXPLICIT_TREATMENT_INTEREST,
  EXPLICIT_RESULT_IMAGE_REQUEST,
  MAX_AUTOMATIC_IMAGES_PER_REPLY,
  planPromotionMediaPacing,
  RESULT_MEDIA_SEND_SPACING_MS,
  planResultMediaPacing,
};
