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
  normalizeMediaTranslations,
  resolveLocalizedMedia,
};
