"use strict";

const { normalizeServiceText } = require("./serviceInterest");
const mediaStore = require("../services/mediaStorageService");
const templateMedia = require("../services/whatsappTemplateMediaService");

const RESTRICTED_TREATMENT_TEMPLATES = Object.freeze({
  ns_fu2_pelvis_video: ["骨盆调理"],
  ns_fu3_pelvis_feedback: ["骨盆调理"],
  ns_fu3_face_feedback: ["3D 小颜术", "9D 逆龄抗衰", "3D + 9D 组合"],
});
const canonical = (name) => normalizeServiceText(name || "");
const sameService = (a, b) => !!canonical(a) && canonical(a) === canonical(b);

function allowedForTreatment(templateName, treatment) {
  const accepted = RESTRICTED_TREATMENT_TEMPLATES[templateName];
  return !accepted || accepted.some((service) => sameService(service, treatment));
}

// Known library assets carry a reliable service association from the clinic's
// active promotions / regular Follow-up Tools. Generic uploaded media must be
// assigned explicitly to a treatment, not sent indiscriminately to every lead.
function mediaOptionMatches(option, { templateName, serviceName, treatment }) {
  if (!option || !["IMAGE", "VIDEO"].includes(option.format)) return false;
  if (!templateMedia.isTemplateCompatible(templateName, option)) return false;
  if (serviceName === "*" || !sameService(serviceName, treatment)) return false;
  if (!allowedForTreatment(templateName, treatment)) return false;
  if (option.serviceName && !sameService(option.serviceName, serviceName)) return false;
  return true;
}

function isSafeTemplateMediaContext(spec, template, {
  config,
  now = Date.now(),
} = {}) {
  if (!template || !spec) return false;
  const templateName = String(template.name || spec.templateName || "");
  const sourceId = String(spec.mediaSourceId || "");
  const media = String(spec.mediaKey || "").trim();
  const isolation = mediaStore.getMediaIsolationStatus();
  if (media && isolation.prefix &&
      !media.startsWith(`${isolation.prefix}/messages/follow-up-config/`)) return false;
  const treatment = spec.identifiedTreatment;
  const configuredRule = spec.serviceName;

  // Explicitly targeted overrides must match this conversation's current
  // treatment; otherwise fall back to the worker's normal skip behavior.
  if (configuredRule && configuredRule !== "*" &&
      !sameService(configuredRule, treatment)) return false;
  if (!allowedForTreatment(templateName, treatment)) return false;
  if (!media && !spec.mediaUrl) return sourceId === "";
  // Static treatment-media needs an explicit service binding.
  if (!configuredRule || configuredRule === "*" || !sameService(configuredRule, treatment)) return false;

  const options = templateMedia.listReusableMedia({ config, now });
  if (sourceId) {
    const source = options.find((item) => item.id === sourceId);
    if (!source || !mediaOptionMatches(source, {
      templateName, serviceName: configuredRule, treatment,
    })) return false;
    // A promotion-derived image is copied into clinic R2 on selection.
    // Its origin must remain active. Validate binding to original image via
    // R2 upload metadata separately in validateApprovedMedia.
    if (source.format === "IMAGE") return sourceId.startsWith("promo:") &&
      template.header?.format === "IMAGE" && Boolean(media);
    return source.mediaKey === media && template.header?.format === source.format;
  }
  // Older stored follow-up video refs remain supported, but only with their
  // configured treatment and template's permitted treatment class.
  const known = options.find((item) => item.mediaKey === media);
  if (known) return mediaOptionMatches(known, {
    templateName, serviceName: configuredRule, treatment,
  }) && template.header?.format === known.format;

  // A clinic-owned uploaded video/image is an explicitly assigned asset.
  // Ownership and MIME are still independently checked by the send guard.
  return !media || mediaStore.isSharedFollowUpConfigKey(media);
}

function invalidConfiguredMediaRule(rules, config, now = Date.now()) {
  const options = templateMedia.listReusableMedia({ config, now });
  for (const [index, rule] of (rules || []).entries()) {
    const mediaKey = String(rule.mediaKey || "");
    const mediaUrl = String(rule.mediaUrl || "");
    const sourceId = String(rule.mediaSourceId || "");
    if (!mediaKey && !mediaUrl && !sourceId) continue;
    if (!rule.serviceName || rule.serviceName === "*") {
      return { index, reason: "Choose a specific treatment for every static image/video." };
    }
    if (!allowedForTreatment(rule.templateName, rule.serviceName)) {
      return { index, reason: "This template does not match the selected treatment." };
    }
    const option = sourceId
      ? options.find((entry) => entry.id === sourceId)
      : options.find((entry) => entry.mediaKey === mediaKey);
    if (sourceId && !option) {
      return { index, reason: "The source image/video is no longer active or available." };
    }
    if (option && !mediaOptionMatches(option, {
      templateName: rule.templateName,
      serviceName: rule.serviceName,
      treatment: rule.serviceName,
    })) {
      return { index, reason: "The media belongs to a different treatment or template." };
    }
    if (sourceId?.startsWith("video:") && option?.mediaKey !== mediaKey) {
      return { index, reason: "The chosen video no longer matches its saved reference." };
    }
    if (sourceId?.startsWith("promo:") && (!mediaKey || !sourceId.endsWith(String(option?.imageId)))) {
      return { index, reason: "The selected promotional image does not match its source." };
    }
  }
  return null;
}

module.exports = {
  allowedForTreatment, mediaOptionMatches, isSafeTemplateMediaContext, invalidConfiguredMediaRule,
};
