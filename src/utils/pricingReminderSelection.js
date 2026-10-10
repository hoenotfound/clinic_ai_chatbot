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
  const crmService = services.find((service) => norm(service.name) === saved)?.name;
  if (crmService) return crmService;
  // Ad-derived treatment is a last-resort baseline, never above the current
  // customer's explicit choice or a valid CRM treatment.
  return inferConfiguredServiceFromText(candidate.ad_name, {
    services, serviceAliases: aliases,
  }) || null;
}
// Pricing reminders are scheduled treatment follow-ups. They must NOT depend
// on whether the customer proactively asked about a price.
function hasPricingInterest(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) =>
    /(?:价钱|价格|價錢|價格|多少钱|多少錢|收费|費用|优惠|優惠|套餐|配套|how\s+much|pricing|price|cost|package|promo|harga|berapa|pakej|promosi|rm\s*\d)/iu
      .test(String(message || ""))
  );
}

function evaluatePricingReminder({
  promotions, candidate, services = [], aliases = [], language = "zh",
  requirePricingInterest = false, sendBothPelvicPackages = true,
}) {
  const service = selectedService(candidate, services, aliases);
  if (!service) return { offer: null, offers: [], reason: "ambiguous_service" };
  const matching = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion) => norm(promotion.linkedService) === norm(service)
  );
  if (matching.length !== 1) return { offer: null, offers: [], reason: "missing_promotion" };
  if (requirePricingInterest && !hasPricingInterest(candidate.recent_customer_messages)) {
    return { offer:null, offers:[], reason:"no_pricing_interest" };
  }

  const packages = promotionPackages(matching[0]);
  if (!packages.length) return { offer: null, offers: [], reason: "missing_promotion" };

  // Only the exact two-package 骨盆调理 promotion sends A and B when the
  // customer hasn't selected one. Never broadcast all packages of other
  // services or turn a 3D-versus-9D comparison into a combination purchase.
  const pelvisAB = sendBothPelvicPackages && norm(service) === norm("骨盆调理") &&
    packages.length === 2 &&
    packages.some((item) => norm(item.name) === "package a") &&
    packages.some((item) => norm(item.name) === "package b");

  let explicit = null;
  let ambiguous = false;
  for (const message of candidate.recent_customer_messages || []) {
    const mentioned = findMentionedPromotionPackages(packages, String(message || ""));
    if (mentioned.length > 1) { ambiguous = true; break; }
    if (mentioned.length === 1) { explicit = mentioned[0]; break; }
  }
  if (ambiguous && !pelvisAB) {
    return { offer: null, offers: [], reason: "ambiguous_package" };
  }
  const selected = packages.length === 1
    ? packages
    : pelvisAB && (ambiguous || !explicit)
      ? packages
      : explicit ? [explicit] : [];
  if (!selected.length) return { offer: null, offers: [], reason: "ambiguous_package" };

  const configuredOffers = selected.map((item) => {
    const media = resolveLocalizedMedia(item, language);
    if (!media?.imageUrl || !media?.caption || !item.name) return null;
    const identities = [...new Set(
      mediaVariants(item).map((variant) => imageIdentity(variant.imageUrl)).filter(Boolean)
    )];
    return {
      serviceName: service,
      promotionName: matching[0].name,
      packageName: item.name,
      caption: media.caption,
      imageUrl: media.imageUrl,
      identities,
    };
  });
  // Do not send only A when Package B is misconfigured.
  if (configuredOffers.some((offer) => !offer)) {
    return { offer: null, offers: [], reason: "missing_promotion" };
  }
  // Prevent two configured packages from claiming the same graphic.
  if (new Set(configuredOffers.map((offer) => imageIdentity(offer.imageUrl))).size !== configuredOffers.length) {
    return { offer: null, offers: [], reason: "ambiguous_package" };
  }

  const channel = norm(candidate.channel || "whatsapp");
  const previous = (Array.isArray(candidate.sent_media) ? candidate.sent_media : [])
    .filter((message) => norm(message.delivery_status) !== "cancelled" &&
      String(message.content || "").trim());
  let needsReview = false;
  const offers = configuredOffers.filter((offer) => {
    const matchingMedia = previous.filter((message) =>
      offer.identities.includes(imageIdentity(message.media_url))
    );
    if (!matchingMedia.length) return true;
    const accepted = matchingMedia.some((message) => {
      const status = norm(message.delivery_status);
      if (["sent", "delivered", "read"].includes(status)) return true;
      // Preserve the existing WhatsApp accepted-but-pending rule. A social
      // caption-only provider ID must never count as a completed image send.
      if (status === "pending") {
        return channel === "whatsapp" && Boolean(message.whatsapp_message_id);
      }
      // Legacy Messenger/Instagram AI replies saved a NULL delivery_status.
      // Meta sends the caption and image separately: require BOTH distinct
      // accepted provider IDs, including the persisted final image ID.
      // Unknown/failed statuses still require review, even with old aliases.
      if (status || !["facebook", "instagram"].includes(channel)) return false;
      return Number.isFinite(Date.parse(message.social_accepted_at)) &&
        String(message.whatsapp_message_id || "").startsWith(channel + ":") &&
        message.social_final_id_recorded === true &&
        Number(message.social_provider_id_count) >= 2;
    });
    if (accepted) return false;
    needsReview = true;
    return false;
  });
  // If delivery of one graphic is uncertain, do not blindly continue the
  // package set. Staff must check whether the missing media reached WhatsApp.
  if (needsReview) return { offer: null, offers: [], reason: "delivery_review" };
  if (!offers.length) return { offer: null, offers: [], reason: "already_sent" };

  return { offer: offers[0], offers, reason: null };
}

function selectPricingOffer(options) {
  const result = evaluatePricingReminder(options);
  return result.offers.length === 1 ? result.offers[0] : null;
}
module.exports = { evaluatePricingReminder, selectPricingOffer, imageIdentity, selectedService, hasPricingInterest };
