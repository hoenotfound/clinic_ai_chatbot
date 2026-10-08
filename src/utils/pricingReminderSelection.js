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
function evaluatePricingReminder({ promotions, candidate, services = [], aliases = [], language = "zh" }) {
  const service = selectedService(candidate, services, aliases);
  if (!service) return { offer: null, reason: "ambiguous_service" };
  const matching = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion) => norm(promotion.linkedService) === norm(service)
  );
  if (matching.length !== 1) return { offer: null, reason: "missing_promotion" };

  const packages = promotionPackages(matching[0]);
  if (!packages.length) return { offer: null, reason: "missing_promotion" };
  let selected;
  if (packages.length === 1) {
    selected = packages[0];
  } else {
    // Fail closed on a comparison, even if the customer mentions both options.
    for (const message of candidate.recent_customer_messages || []) {
      const mentioned = findMentionedPromotionPackages(packages, String(message || ""));
      if (mentioned.length > 1) return { offer: null, reason: "ambiguous_package" };
      if (mentioned.length === 1) {
        selected = mentioned[0];
        break;
      }
    }
  }
  if (!selected) return { offer: null, reason: "ambiguous_package" };
  const media = resolveLocalizedMedia(selected, language);
  if (!media?.imageUrl || !media?.caption) {
    return { offer: null, reason: "missing_promotion" };
  }
  const variants = mediaVariants(selected);
  const identities = [...new Set(
    variants.map((variant) => imageIdentity(variant.imageUrl)).filter(Boolean)
  )];
  const previous = (Array.isArray(candidate.sent_media) ? candidate.sent_media : [])
    .filter((message) =>
      identities.includes(imageIdentity(message.media_url)) &&
      String(message.content || "").trim()
    );

  const knownAccepted = previous.some((message) => {
    const status = norm(message.delivery_status);
    return ["sent", "delivered", "read"].includes(status) ||
      (status === "pending" && Boolean(message.whatsapp_message_id));
  });
  if (knownAccepted) return { offer: null, reason: "already_sent" };
  if (previous.length > 0) {
    // A failed/unknown/pending-without-provider-id record is not proof of
    // delivery. Never silently count it as sent or blindly retry it.
    return { offer: null, reason: "delivery_review" };
  }
  return {
    reason: null,
    offer: {
      serviceName: service,
      promotionName: matching[0].name,
      packageName: selected.name,
      caption: media.caption,
      imageUrl: media.imageUrl,
      identities,
    },
  };
}

function selectPricingOffer(options) {
  return evaluatePricingReminder(options).offer;
}
module.exports = { evaluatePricingReminder, selectPricingOffer, imageIdentity, selectedService };
