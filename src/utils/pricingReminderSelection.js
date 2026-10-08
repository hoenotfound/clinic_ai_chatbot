const { findMentionedPromotionPackages, promotionPackages } = require("./activePromotion");
const { resolveLocalizedMedia, mediaVariants } = require("./mediaLocalization");
const { inferConfiguredServiceFromText } = require("./serviceInterest");

function norm(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
function imageIdentity(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text, "https://placeholder.invalid");
    return url.pathname.replace(/\/+$/, "");
  } catch {
    return text.split("?")[0];
  }
}
function selectedService(candidate, services, aliases = []) {
  const messages = Array.isArray(candidate.recent_customer_messages)
    ? candidate.recent_customer_messages : [];
  for (const entry of messages) {
    const text = String(entry || "");
    // Do not convert a comparison into the combination treatment.
    if (/(?:3\s*d).*(?:\bor\b|还是|或者|vs\.?|或)(?:.*9\s*d)|(?:9\s*d).*(?:\bor\b|还是|或者|vs\.?|或)(?:.*3\s*d)/iu.test(text)) {
      return null;
    }
    const inferred = inferConfiguredServiceFromText(text, { services, serviceAliases: aliases });
    if (inferred) return inferred;
    const normalizedText = norm(text);
    const matched = services.filter((service) => {
      const terms = [service.name, ...aliases.filter((alias) => norm(alias.officialService) === norm(service.name)).map((alias) => alias.alias)];
      return terms.some((term) => norm(term).length > 2 && normalizedText.includes(norm(term)));
    });
    if (matched.length > 1) return null;
    if (matched.length === 1) return matched[0].name;
  }
  const saved = norm(candidate.treatment_interest);
  return services.find((service) => norm(service.name) === saved)?.name || null;
}
function selectPricingOffer({ promotions, candidate, services = [], aliases = [], language = "zh" }) {
  const service = selectedService(candidate, services, aliases);
  if (!service) return null;
  const matching = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion) => norm(promotion.linkedService) === norm(service)
  );
  if (matching.length !== 1) return null;

  const packages = promotionPackages(matching[0]);
  if (!packages.length) return null;
  let selected;
  if (packages.length === 1) {
    selected = packages[0];
  } else {
    // A multi-package treatment must have an explicit, unambiguous customer
    // selection. Never send both prices or let AI infer a package.
    for (const message of candidate.recent_customer_messages || []) {
      const mentioned = findMentionedPromotionPackages(packages, String(message || ""));
      if (mentioned.length > 1) return null;
      if (mentioned.length === 1) {
        selected = mentioned[0];
        break;
      }
    }
  }
  if (!selected) return null;
  const media = resolveLocalizedMedia(selected, language);
  if (!media?.imageUrl || !media?.caption) return null;
  const variants = mediaVariants(selected);
  const identities = [...new Set(variants.map((variant) => imageIdentity(variant.imageUrl)).filter(Boolean))];
  const previous = Array.isArray(candidate.sent_media) ? candidate.sent_media : [];
  // Including pending/failed/unknown media prevents ambiguous double delivery;
  // staff can retry failures from Inbox.
  if (previous.some((message) =>
    identities.includes(imageIdentity(message.media_url)) &&
    String(message.content || "").trim()
  )) return null;
  return {
    serviceName: service,
    promotionName: matching[0].name,
    packageName: selected.name,
    caption: media.caption,
    imageUrl: media.imageUrl,
    identities,
    imageUrls: variants.map((variant) => variant.imageUrl).filter(Boolean),
  };
}
module.exports = { selectPricingOffer, imageIdentity, selectedService };
