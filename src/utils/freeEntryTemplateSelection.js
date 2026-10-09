const { detectConversationLanguage } = require("./chatLanguage");
const { isIP } = require("node:net");
const { normalizeServiceText, inferConfiguredServiceFromText } = require("./serviceInterest");
const mediaStorage = require("../services/mediaStorageService");
const clinicConfig = require("../config/clinicConfig");
const promoImagesRepo = require("../db/promoImagesRepo");
const templateMedia = require("../services/whatsappTemplateMediaService");
const { isSafeTemplateMediaContext } = require("./followUpTemplateMediaPolicy");
const { findMentionedPromotionPackages } = require("./activePromotion");

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
    (serviceName === "*" || services.some((service) =>
      normalizeServiceText(service.name) === normalizeServiceText(serviceName)
    )) &&
    /^[a-z0-9_]+$/.test(templateName) &&
    validMediaUrl(rule.mediaUrl || "") &&
    !(rule.mediaKey && rule.mediaUrl) &&
    (!rule.mediaSourceId || (
      typeof rule.mediaSourceId === "string" &&
      rule.mediaSourceId.length <= 100 &&
      /^(?:promo:[1-9]\d*|video:[a-f0-9]{24})$/.test(rule.mediaSourceId) &&
      Boolean(rule.mediaKey) && !rule.mediaUrl
    )) &&
    (!rule.mediaKey ||
      (mediaStorage.isSharedFollowUpConfigKey(rule.mediaKey) &&
        /\.(?:mp4|jpe?g|png)$/i.test(rule.mediaKey)));
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
  const sameLeadJourney = candidate.latest_ad_message_id == null ||
    (candidate.lead_started_message_id != null &&
      String(candidate.lead_started_message_id) === String(candidate.latest_ad_message_id));
  const interest = normalizeServiceText(customerInterest || adInterest ||
    (sameLeadJourney ? candidate.treatment_interest : null) || "");
  const rules = settings.templateRules || [];
  const matching = rules.find((rule) =>
    rule.slotHours === slotHours &&
    rule.serviceName !== "*" &&
    normalizeServiceText(rule.serviceName) === interest
  ) || rules.find((rule) =>
    rule.slotHours === slotHours && rule.serviceName === "*"
  );
  return {
    templateName: matching?.templateName || settings.templateName,
    language: locale,
    mediaUrl: matching?.mediaUrl || "",
    mediaKey: matching?.mediaKey || "",
    mediaSourceId: matching?.mediaSourceId || "",
    videoCodecVerified: matching?.videoCodecVerified === true,
    serviceName: matching?.serviceName || null,
    identifiedTreatment: customerInterest || adInterest ||
      (sameLeadJourney ? candidate.treatment_interest : null) || null,
    recentInboundMessages: candidate.recent_inbound_messages || [],
    slotHours,
  };
}


const AUTO_IMAGE_TEMPLATES = new Set(["ns_fu_pricing_graphic", "ns_fu_meridian_gift"]);
const AUTO_VARIABLE_TEMPLATES = new Set(["ns_fu1_service_checkin", ...AUTO_IMAGE_TEMPLATES]);

function exactConfiguredService(value, config = clinicConfig) {
  const normalized = normalizeServiceText(value);
  if (!normalized) return null;
  return (config.services || []).find((item) =>
    normalizeServiceText(item?.name) === normalized)?.name || null;
}

function chosenPelvisPackage(messages = [], packages = []) {
  // Match the exact currently configured package names, titles and aliases.
  // Every mention in the recent customer messages is considered; opposing
  // choices or "A or B" must fail closed instead of guessing a package.
  const options = Array.isArray(packages) ? packages : [];
  const packageA = options.find((item) =>
    normalizeServiceText(item?.name) === "package a");
  const packageB = options.find((item) =>
    normalizeServiceText(item?.name) === "package b");
  if (!packageA || !packageB || options.length !== 2) return null;
  const mentioned = new Set();
  for (const entry of Array.isArray(messages) ? messages.slice(0, 8) : []) {
    const message = String(entry || "").normalize("NFKC");
    // Shorthand comparisons such as "Package A or B" mention both packages,
    // even though the second one does not repeat the word "Package".
    if (/(?:\bA\b.{0,20}\bB\b|\bB\b.{0,20}\bA\b)/iu.test(message) &&
        /(?:package|pakej|配套|套餐|还是|或者|或是|比较|\bor\b|\bvs\b)/iu.test(message)) {
      return null;
    }
    for (const match of findMentionedPromotionPackages(options, message)) {
      mentioned.add(normalizeServiceText(match.name));
    }
    // Clinic package titles often append duration after a separator, e.g.
    // "尊享护理配套｜2小时30分钟". A distinctive configured title prefix may
    // be used without requiring the customer to repeat the whole title.
    for (const option of options) {
      const prefix = String(option.title || "").split(/[｜|—–]/)[0].trim();
      if (prefix.length >= 6 && message.includes(prefix)) {
        mentioned.add(normalizeServiceText(option.name));
      }
    }
    if (mentioned.size > 1) return null;
  }
  if (mentioned.size !== 1) return null;
  const choice = [...mentioned][0];
  return choice === "package a" ? "A" :
    choice === "package b" ? "B" : null;
}

/**
 * Values and images are derived solely from a configured service, an active
 * promotion and a fresh approved template definition; never AI-authored.
 * If multiple packages/assets are possible, skip rather than guessing.
 */
function enrichAutomatedTemplateSpec(spec, template, {
  config = clinicConfig, now = Date.now(),
} = {}) {
  if (!spec || !template || template.name !== spec.templateName) return null;
  if (!AUTO_VARIABLE_TEMPLATES.has(template.name)) return { ...spec, bodyValue: null };
  if (spec.mediaKey || spec.mediaUrl) return null; // auto templates cannot override the approved promotion asset
  const service = exactConfiguredService(spec.identifiedTreatment, config);
  if (!service) return null;
  if (template.name === "ns_fu1_service_checkin") {
    return { ...spec, bodyValue: templateMedia.expectedMediaValue({ serviceName: service }, template.language) };
  }

  const options = templateMedia.listReusableMedia({ config, now }).filter((item) =>
    item.format === "IMAGE" &&
    normalizeServiceText(item.serviceName) === normalizeServiceText(service) &&
    templateMedia.isTemplateCompatible(template.name, item)
  );
  let matching = options;
  if (normalizeServiceText(service) === normalizeServiceText("骨盆调理")) {
    const activePromotions = (config.promotions || []).filter((promotion) =>
      normalizeServiceText(promotion?.linkedService) === normalizeServiceText(service) &&
      templateMedia.currentlyValid(promotion, now, config.timezone || config.timeZone)
    );
    const active = activePromotions.length === 1 ? activePromotions[0] : null;
    const choice = active ? chosenPelvisPackage(
      spec.recentInboundMessages || [], active.packages || []
    ) : null;
    matching = choice
      ? options.filter((item) =>
          normalizeServiceText(item.packageName) === "package " + choice.toLowerCase())
      : [];
  }
  if (matching.length !== 1 || !matching[0].imageId) return null;
  const option = matching[0];
  const bodyValue = templateMedia.expectedMediaValue(option, template.language);
  if (!bodyValue) return null;
  return {
    ...spec, bodyValue, autoPromoImageId: option.imageId,
    autoPromoSelectionId: option.id, autoPromoMimeType: null,
  };
}

async function prepareAutoPromotionMedia(spec, {
  promos = promoImagesRepo, validateImage = templateMedia.prepareImage,
} = {}) {
  if (!Number.isSafeInteger(spec?.autoPromoImageId) || spec.autoPromoImageId <= 0 ||
      spec?.mediaKey || spec?.mediaUrl) return null;
  const record = await promos.getPublicImage(spec.autoPromoImageId);
  if (!record || !["image/jpeg", "image/png"].includes(record.mime_type) ||
      typeof record.data !== "string") return null;
  // Check encoded size before allocating the decoded body.
  if (record.data.length > Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8) return null;
  const buffer = await validateImage(Buffer.from(record.data, "base64"), record.mime_type);
  if (!buffer || buffer.length <= 0 || buffer.length > 5 * 1024 * 1024) return null;
  return {
    buffer, mimeType: record.mime_type,
    filename: "follow-up-promotion-" + spec.autoPromoImageId +
      (record.mime_type === "image/png" ? ".png" : ".jpg"),
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
      !/\.(?:mp4|jpe?g|png)$/i.test(spec.mediaKey)) return null;
  try {
    return { ...spec, mediaUrl: mediaStorage.createPresignedGetUrl(spec.mediaKey, { expiresSeconds: 30 * 60 }) };
  } catch { return null; }
}

/**
 * Fail closed for missing/bad media. Validate owned R2 objects with HEAD
 * (no video download or transcoding) and explicitly trusted HTTPS hosts with
 * a bounded no-redirect HEAD request. Meta may still reject unsupported
 * codecs; H.264/AAC compatibility must be checked during original upload.
 */
async function validateApprovedMedia(template, spec, {
  env = process.env, mediaStore = mediaStorage, fetchImpl = fetch,
  promos = promoImagesRepo, validateImage = templateMedia.prepareImage,
  config = clinicConfig, now = Date.now(),
} = {}) {
  if (!template || !spec) return false;
  if (!isSafeTemplateMediaContext(spec, template, { config, now })) return false;
  const format = template.header?.format || "TEXT";
  if (spec.autoPromoImageId) {
    if (format !== "IMAGE" || spec.mediaKey || spec.mediaUrl) return false;
    try {
      if (typeof promos.getPublicImageMetadata === "function") {
        // Never assume a cached provider image remains public; check the
        // purpose/MIME and encoded size without fetching its full base64 body.
        const metadata = await promos.getPublicImageMetadata(spec.autoPromoImageId);
        const encoded = Number(metadata?.encoded_length);
        return ["image/jpeg","image/png"].includes(metadata?.mime_type) &&
          Number.isSafeInteger(encoded) && encoded > 0 &&
          encoded <= Math.ceil(5 * 1024 * 1024 * 4 / 3) + 8;
      }
      return Boolean(await prepareAutoPromotionMedia(spec, { promos, validateImage }));
    } catch { return false; }
  }
  const expected = format === "VIDEO" ? ["video/mp4", 16*1024*1024] :
    format === "IMAGE" ? ["image/jpeg", 5*1024*1024] : null;
  if (!expected) return !spec.mediaKey && !spec.mediaUrl;
  // H.264/AAC codecs cannot be proven by a HEAD response. Require the
  // clinic to explicitly verify its pre-encoded MP4 rather than silently
  // send an unknown HEVC file as a promotional template.
  if (format === "VIDEO" && spec.videoCodecVerified !== true) return false;
  const [expectedMime, maxBytes] = expected;
  let info;
  try {
    if (spec.mediaKey) {
      if (!mediaStore.isSharedFollowUpConfigKey(spec.mediaKey)) return false;
      const extension = spec.mediaKey.toLowerCase();
      if (format === "VIDEO" && !extension.endsWith(".mp4")) return false;
      if (format === "IMAGE" && !/\.(?:jpe?g|png)$/.test(extension)) return false;
      info = await mediaStore.getSharedFollowUpMediaInfo(spec.mediaKey);
      if (spec.mediaSourceId?.startsWith("promo:")) {
        // Origin metadata is signed by R2's own object HEAD response, not by
        // browser-supplied fields. Retired/changed promos fail closed.
        const imageId = String(spec.mediaSourceId.slice("promo:".length));
        if (String(info?.metadata?.["clinic-promo-image-id"] || "") !== imageId)
          return false;
      }
    } else if (spec.mediaUrl) {
      const url = new URL(spec.mediaUrl);
      const allowed = String(env.WHATSAPP_FEP_MEDIA_ALLOWED_HOSTS || "")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!allowed.includes(url.hostname.toLowerCase()) ||
          url.protocol !== "https:" || isIP(url.hostname) ||
          url.hostname.toLowerCase() === "localhost" ||
          !validMediaUrl(spec.mediaUrl)) return false;
      const response = await fetchImpl(spec.mediaUrl, {
        method: "HEAD", redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      info = {
        bytes: Number(response.headers.get("content-length")),
        mimeType: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(),
      };
    } else return false;
    if (!Number.isSafeInteger(info?.bytes) || info.bytes <= 0 ||
        info.bytes > maxBytes) return false;
    if (format === "IMAGE")
      return ["image/jpeg","image/png"].includes(info.mimeType);
    return info.mimeType === expectedMime;
  } catch { return false; }
}

function buildStaticMarketingTemplate(template, spec, templatesService, {
  mediaId = null, allowUnuploadedMedia = false,
} = {}) {
  if (!template || template.category !== "MARKETING" ||
      template.status !== "APPROVED" ||
      !Array.isArray(template.variableFields) ||
      !template.body?.text || !spec || !validMediaUrl(spec.mediaUrl)) return null;

  const format = template.header?.format || "TEXT";
  const needsMedia = ALLOWED_MEDIA_TYPES.has(format);
  const autoImage = Boolean(spec.autoPromoImageId);
  const linked = Boolean(spec.mediaUrl);
  const values = { header: [], body: [] };
  if (template.variableFields.length) {
    if (!AUTO_VARIABLE_TEMPLATES.has(template.name) ||
        template.variableFields.length !== 1 ||
        template.variableFields[0].component !== "body" ||
        template.variableFields[0].index !== 1 ||
        !template.body.text.includes("{{1}}") ||
        typeof spec.bodyValue !== "string" ||
        !spec.bodyValue.trim() || spec.bodyValue.length > 160) return null;
    values.body = [spec.bodyValue.trim()];
  } else if (AUTO_VARIABLE_TEMPLATES.has(template.name) || spec.bodyValue) {
    // A named automated template whose approved variable signature changes
    // must fail closed instead of sending the wrong treatment in its copy.
    return null;
  }
  if (autoImage && (format !== "IMAGE" || linked || spec.mediaKey)) return null;
  if (needsMedia !== (autoImage || linked) ||
      (!needsMedia && format !== "TEXT") ||
      (template.buttons || []).some((button) =>
        !["QUICK_REPLY", "PHONE_NUMBER", "URL"].includes(button.type))) return null;
  if (mediaId && (!autoImage || !/^\d+$/.test(String(mediaId)))) return null;
  if (autoImage && !mediaId && !allowUnuploadedMedia) return null;

  const compatibilityTemplate = { ...template, sendable: true, unsupportedReason: null };
  const built = templatesService.buildTemplateComponents(compatibilityTemplate, values, {
    allowMissingMedia: needsMedia,
  });
  if (!built.valid) return null;

  const components = built.components.slice();
  if (needsMedia && (linked || mediaId)) {
    components.unshift({
      type: "header",
      parameters: [{
        type: format.toLowerCase(),
        [format.toLowerCase()]: mediaId ? { id: String(mediaId) } : { link: spec.mediaUrl },
      }],
    });
  }
  const preview = templatesService.renderTemplatePreview(compatibilityTemplate, values);
  if (!preview) return null;
  return { components, preview, values };
}

module.exports = {
  SUPPORTED_LANGUAGES,
  LANGUAGE_MAP,
  validMediaUrl,
  validateTemplateRules,
  selectTemplateSpec,
  materializeTemplateMediaSpec,
  buildStaticMarketingTemplate,
  validateApprovedMedia,
  enrichAutomatedTemplateSpec,
  prepareAutoPromotionMedia,
  chosenPelvisPackage,
};
