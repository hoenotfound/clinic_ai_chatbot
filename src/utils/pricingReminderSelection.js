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
// A treatment-specific reminder may be helpful even when the customer has
// not explicitly asked about pricing. Do not override opt-outs or inferred
// treatment ambiguity; those protections run independently.
function evaluatePricingReminder({ promotions, candidate, services = [], aliases = [], language = "zh" }) {
  const service = selectedService(candidate, services, aliases);
  if (!service) return { offer: null, offers: [], reason: "ambiguous_service" };
  const matching = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion) => norm(promotion.linkedService) === norm(service)
  );
  if (matching.length !== 1) return { offer: null, offers: [], reason: "missing_promotion" };

  const packages = promotionPackages(matching[0]);
  if (!packages.length) return { offer: null, offers: [], reason: "missing_promotion" };
  let selected = [];
  if (packages.length === 1) {
    selected = packages;
  } else {
    // The pelvic campaign offers two alternatives. If the customer has not
    // explicitly chosen one, show BOTH prices so they can compare.
    const pelvicPair = norm(service) === norm("骨盆调理") &&
      packages.length === 2 &&
      packages.every((pkg) => /^package [ab]$/iu.test(String(pkg.name || "").trim()));
    for (const message of candidate.recent_customer_messages || []) {
      const mentioned = findMentionedPromotionPackages(packages, String(message || ""));
      if (mentioned.length > 1) {
        selected = pelvicPair ? packages : [];
        break;
      }
      if (mentioned.length === 1) {
        selected = mentioned;
        break;
      }
    }
    if (!selected.length && pelvicPair) selected = packages;
  }
  if (!selected.length) return { offer: null, offers: [], reason: "ambiguous_package" };

  const priorMedia = Array.isArray(candidate.sent_media) ? candidate.sent_media : [];
  const offers = [];
  let skippedAccepted = 0;
  for (const pkg of selected) {
    const media = resolveLocalizedMedia(pkg, language);
    if (!media?.imageUrl || !media?.caption) {
      return { offer: null, offers: [], reason: "missing_promotion" };
    }
    const identities = [...new Set(
      mediaVariants(pkg).map((variant) => imageIdentity(variant.imageUrl)).filter(Boolean)
    )];
    const previous = priorMedia.filter((item) =>
      identities.includes(imageIdentity(item.media_url)) && String(item.content || "").trim()
    );
    const accepted = previous.some((item) =>
      ["sent", "delivered", "read"].includes(norm(item.delivery_status)) ||
      (norm(item.delivery_status) === "pending" && Boolean(item.whatsapp_message_id))
    );
    if (accepted) {
      skippedAccepted += 1;
      continue;
    }
    if (previous.length) {
      return { offer: null, offers: [], reason: "delivery_review" };
    }
    offers.push({
      serviceName: service,
      promotionName: matching[0].name,
      packageName: pkg.name,
      caption: media.caption,
      imageUrl: media.imageUrl,
      identities,
    });
  }
  return {
    offer: offers[0] || null,
    offers,
    reason: offers.length ? null : (skippedAccepted ? "already_sent" : "missing_promotion"),
  };
}

function selectPricingOffer(options) {
  return evaluatePricingReminder(options).offer;
}
module.exports = { evaluatePricingReminder, selectPricingOffer, imageIdentity, selectedService };
