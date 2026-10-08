const { detectConversationLanguage } = require("./chatLanguage");
const { normalizeServiceText, inferConfiguredServiceFromText } = require("./serviceInterest");
const mediaStorage = require("../services/mediaStorageService");

const LANGUAGE_MAP = Object.freeze({ zh: "zh_CN", en: "en_US", ms: "ms" });
const SUPPORTED_LANGUAGES = new Set(["auto", "zh_CN", "en_US", "ms"]);
const ALLOWED_MEDIA_TYPES = new Set(["IMAGE", "VIDEO"]);

function validMediaUrl(value) {
  if (!value) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username &&
      !url.password && !url.hash;
  } catch {
    return false;
  }
}

function templateRuleValid(rule, slots, services) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
  const serviceName = String(rule.serviceName || "").trim();
  const templateName = String(rule.templateName || "").trim();
  return Number.isInteger(rule.slotHours) && slots.includes(rule.slotHours) &&
    serviceName.length > 0 &&
    services.some((service) =>
      normalizeServiceText(service.name) === normalizeServiceText(serviceName)
    ) &&
    /^[a-z0-9_]+$/.test(templateName) &&
    validMediaUrl(rule.mediaUrl || "") &&
    !(rule.mediaKey && rule.mediaUrl) &&
    (!rule.mediaKey ||
      (mediaStorage.isSharedFollowUpConfigKey(rule.mediaKey) &&
        rule.mediaKey.toLowerCase().endsWith(".mp4")));
}

function validateTemplateRules(rules, slots, services = []) {
  if (!Array.isArray(rules) || rules.length > 60) return false;
  if (!rules.every((rule) => templateRuleValid(rule, slots, services))) return false;
  const keys = rules.map((rule) =>
    String(rule.slotHours) + ":" + normalizeServiceText(rule.serviceName)
  );
  return new Set(keys).size === keys.length;
}

function selectTemplateSpec(candidate, slotHours, settings) {
  const locale = settings.language === "auto"
    ? LANGUAGE_MAP[detectConversationLanguage(candidate.recent_inbound_messages || [], "zh")] || "zh_CN"
    : settings.language;
  if (!SUPPORTED_LANGUAGES.has(locale) || locale === "auto") return null;
  // User's explicit treatment messages in THIS ad enquiry override the ad name.
  // A previous lead's CRM treatment never silently targets a later, unrelated ad.
  const customerInterest = (candidate.recent_inbound_messages || [])
    .map((message) => inferConfiguredServiceFromText(message))
    .find(Boolean);
  const adInterest = candidate.referral_treatment_interest ||
    inferConfiguredServiceFromText(candidate.referral_ad_name);
  const sameLeadJourney = candidate.lead_started_message_id != null &&
    String(candidate.lead_started_message_id) === String(candidate.latest_ad_message_id);
  const interest = normalizeServiceText(customerInterest || adInterest ||
    (sameLeadJourney ? candidate.treatment_interest : null) || "");
  const matching = (settings.templateRules || []).find((rule) =>
    rule.slotHours === slotHours &&
    normalizeServiceText(rule.serviceName) === interest
  );
  return {
    templateName: matching?.templateName || settings.templateName,
    language: locale,
    mediaUrl: matching?.mediaUrl || "",
    mediaKey: matching?.mediaKey || "",
    serviceName: matching?.serviceName || null,
    identifiedTreatment: customerInterest || adInterest ||
      (sameLeadJourney ? candidate.treatment_interest : null) || null,
    slotHours,
  };
}

/**
 * Approved media-header templates must have a media URL specified explicitly.
 * This builder deliberately does not change Inbox's existing template rules.
 * No arbitrary customer/AI text, body/header variables or unaudited media ID.
 */
function materializeTemplateMediaSpec(spec) {
  if (!spec) return null;
  if (!spec.mediaKey) return spec;
  if (!mediaStorage.isSharedFollowUpConfigKey(spec.mediaKey) ||
      !spec.mediaKey.toLowerCase().endsWith(".mp4")) return null;
  try {
    return { ...spec, mediaUrl: mediaStorage.createPresignedGetUrl(spec.mediaKey, { expiresSeconds: 30 * 60 }) };
  } catch { return null; }
}

function buildStaticMarketingTemplate(template, spec, templatesService) {
  if (!template || template.category !== "MARKETING" ||
      template.status !== "APPROVED" ||
      !Array.isArray(template.variableFields) || template.variableFields.length ||
      !template.body?.text || !spec || !validMediaUrl(spec.mediaUrl)) return null;

  const format = template.header?.format || "TEXT";
  const needsMedia = ALLOWED_MEDIA_TYPES.has(format);
  if (needsMedia !== Boolean(spec.mediaUrl) || 
      (!needsMedia && format !== "TEXT") ||
      (template.buttons || []).some((button) =>
        !["QUICK_REPLY", "PHONE_NUMBER", "URL"].includes(button.type)
      )) return null;

  const compatibilityTemplate = { ...template, sendable: true, unsupportedReason: null };
  const built = templatesService.buildTemplateComponents(compatibilityTemplate, {});
  if (!built.valid) return null;

  const components = built.components.slice();
  if (needsMedia) {
    components.unshift({
      type: "header",
      parameters: [{
        type: format.toLowerCase(),
        [format.toLowerCase()]: { link: spec.mediaUrl },
      }],
    });
  }
  const preview = templatesService.renderTemplatePreview(compatibilityTemplate, {});
  if (!preview) return null;
  return { components, preview };
}

module.exports = {
  SUPPORTED_LANGUAGES,
  LANGUAGE_MAP,
  validMediaUrl,
  validateTemplateRules,
  selectTemplateSpec,
  materializeTemplateMediaSpec,
  buildStaticMarketingTemplate,
};
