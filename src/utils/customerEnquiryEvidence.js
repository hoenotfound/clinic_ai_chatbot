const { isGreetingOrLanguageOnly } = require("./chatLanguage");

// Independent evidence from the CURRENT customer text. A model flag or Meta
// attribution is not enough to send unsolicited promotions/result images.
const PRICE_OR_PACKAGE = /(?:\b(?:price|pricing|cost|fees?|charges?|rate|rates|promo(?:tion)?s?|discounts?|vouchers?|packages?|how\s+much|rm\s*\d{2,})\b|\b(?:harga|berapa|pakej|promosi|diskaun|baucar|tawaran)\b|价[格錢钱]|費用|费用|收[费費]|多少[钱錢]|几[多多]|套[餐]|配套|优惠|優惠|折扣|促销|促銷|\b(?:[abc]\s*套餐|package\s*[abc])\b)/iu;

const DECLINED_TREATMENT = /(?:\\b(?:not\\s+interested|no\\s+interest|don['’]?t\\s+want|do\\s+not\\s+want|not\\s+looking\\s+for)\\b|不感兴趣|不感興趣|不想了解|不想做|不要这个|不要這個|没兴趣|沒興趣|tak\\s+(?:berminat|mahu|nak))/iu;

const DECLINED_PRICE = /(?:\b(?:no|not|don['’]?t|do\s+not)\s+(?:need|want|ask(?:ing)?\s+for)\s+(?:the\s+)?(?:price|pricing|package|promo)\b|(?:不[想要需]|不用|无需|不必)(?:知道|了解|问|問)?(?:价格|價錢|价钱|配套|套餐))/iu;

// Positive treatment-interest language, independent of Meta and AI labels.
// Keep this deliberately conservative: absent evidence means no automatic media.
const SERVICE_ENQUIRY = /(?:\b(?:interested|enquir(?:y|e)|inquir(?:y|e)|information|details?|tell\s+me\s+more|learn\s+more|know\s+more|find\s+out|want\s+to\s+(?:know|try|do|improve|treat)|would\s+like\s+to\s+(?:know|try|do|improve|treat)|can\s+(?:i|you)\s+(?:try|do|know|see|improve|treat)|how\s+(?:does|do|can|long)|what\s+(?:is|are|does|results?|benefits?|treatment)|does\s+(?:it|this)|results?|before\s*(?:and|&)\s*after|pelvic|pelvis|postpartum|facial|jawline|double\s+chin|treatment)\b|\b(?:nak\s+(?:tahu|cuba|buat|rawatan)|mahu\s+(?:tahu|cuba|buat)|berminat|rawatan|hasil|kesan|boleh\s+(?:ke|tahu))\b|想了解|想知道|想咨询|想諮詢|想问|想問|想做|感兴趣|感興趣|可以改善|怎么做|怎麼做|如何做|怎么改善|怎麼改善|有什么效果|有什麼效果|有效吗|有效嗎|案例|效果|骨盆|小腹|产后|產後|脸型|臉型|下颚|下顎|双下巴|雙下巴|皮肤松弛|皮膚鬆弛|小颜|小顏|逆龄|逆齡|\b[39]\s*d\b)/iu;

const ACK_ONLY = /^(?:ok(?:ay)?|kk|k|alright|all\s+right|noted|thanks?(?:\s+you)?|thank\s+you|tq|thx|sure|yes|yeah|yep|no|nope|later|fine|got\s+it|received|好的|好|好吧|谢谢|謝謝|收到|明白|嗯|哦|是的|可以|好呀|baik|terima\s+kasih|faham|boleh|ya|tak|👍|🙏|😊|🙂)[\s.!！。~👍🙏😊🙂]*$/iu;
const ADMIN_ONLY = /^(?:(?:where\s+(?:are|is)|what\s+(?:are|is)\s+(?:your|the)|can\s+you\s+(?:give|send)\s+(?:me\s+)?)\s*)?(?:address|location|branch(?:es)?|business\s+hours?|opening\s+hours?|contact|phone\s+number|whatsapp|opening\s+time|clinic\s+location|appointment\s+slots?|营业时间|營業時間|分店|地址|电话号码|電話號碼|在哪里|在哪裡|营业吗|營業嗎|lokasi|alamat|cawangan|waktu\s+operasi)(?:[\s?？!.。]*)$/iu;

function hasCustomerPriceEnquiry(customerText) {
  const value = String(customerText || "").trim();
  if (!value || isGreetingOrLanguageOnly(value) || ACK_ONLY.test(value)) return false;
  if (DECLINED_TREATMENT.test(value) || DECLINED_PRICE.test(value)) return false;
  return PRICE_OR_PACKAGE.test(value);
}

function hasCustomerServiceEnquiry(customerText) {
  const value = String(customerText || "").trim();
  if (!value || isGreetingOrLanguageOnly(value) || ACK_ONLY.test(value)) return false;
  if (ADMIN_ONLY.test(value) || DECLINED_TREATMENT.test(value)) return false;
  return hasCustomerPriceEnquiry(value) || SERVICE_ENQUIRY.test(value);
}

module.exports = { hasCustomerPriceEnquiry, hasCustomerServiceEnquiry };
