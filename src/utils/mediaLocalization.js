const MEDIA_LANGUAGE_KEYS = Object.freeze(["en", "ms", "zh"]);

function normalizeMediaTranslations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const language of MEDIA_LANGUAGE_KEYS) {
    const source = value[language];
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    const imageUrl = String(source.imageUrl || "").trim();
    const caption = String(source.caption || "").trim();
    if (imageUrl || caption) {
      result[language] = {
        ...(imageUrl ? { imageUrl } : {}),
        ...(caption ? { caption } : {}),
      };
    }
  }
  return result;
}

function mediaVariants(item) {
  if (!item || typeof item !== "object") return [];
  const variants = [
    resolveLocalizedMedia(item, null),
    ...MEDIA_LANGUAGE_KEYS.map((language) => resolveLocalizedMedia(item, language)),
  ];
  const seen = new Set();
  return variants.filter((variant) => {
    const imageUrl = String(variant?.imageUrl || "").trim();
    const caption = String(variant?.caption || "").trim();
    if (!imageUrl && !caption) return false;
    const key = JSON.stringify([imageUrl, caption]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveLocalizedMedia(item, language) {
  if (!item || typeof item !== "object") return item;
  const translations = normalizeMediaTranslations(item.mediaTranslations);
  const localized = translations[String(language || "").trim()] || {};
  return {
    ...item,
    imageUrl: String(localized.imageUrl || item.imageUrl || "").trim(),
    caption: String(localized.caption || item.caption || "").trim(),
    mediaTranslations: translations,
  };
}

module.exports = {
  MEDIA_LANGUAGE_KEYS,
  mediaVariants,
  normalizeMediaTranslations,
  resolveLocalizedMedia,
};
