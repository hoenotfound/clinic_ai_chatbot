"use strict";

const { getActivePromotions } = require("./activePromotion");

// Operators may adjust wording in clinic_config.assessmentReplyTemplates.
// The code still decides which service, price/free condition and voucher are
// eligible; an editable text template does NOT authorize those decisions.
function templateText(config, language, key, serviceName = "") {
  const locale = String(language || "").toLowerCase().startsWith("zh") ? "zh"
    : String(language || "").toLowerCase().startsWith("ms") ? "ms" : "en";
  const raw = config?.assessmentReplyTemplates?.[locale]?.[key];
  if (typeof raw !== "string" || !raw.trim() || raw.length > 650) return null;
  return raw.trim().replace(/\{service\}/gu, String(serviceName || "").slice(0, 120));
}

function verifiedPelvicAssessmentVoucher(config, now = new Date()) {
  if (!config || config.businessType !== "tcm_clinic" ||
      !/^Neutro\s+Sense\b/iu.test(String(config.businessName || config.clinicName || ""))) return false;
  return getActivePromotions(config.promotions || [], now).some(promo =>
    promo?.linkedService === "骨盆调理" &&
    (Array.isArray(promo.packages) ? promo.packages : [])
      .some(pkg => /RM\s*100\s*(?:优惠券|優惠券|voucher|baucar)/iu.test(String(pkg.caption || "")))
  );
}

module.exports = { templateText, verifiedPelvicAssessmentVoucher };
