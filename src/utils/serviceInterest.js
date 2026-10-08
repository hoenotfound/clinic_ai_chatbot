const clinicConfig = require("../config/clinicConfig");

function normalizeServiceText(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase()
    : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textContainsTerm(normalizedText, normalizedTerm) {
  if (!normalizedText || !normalizedTerm) return false;

  // Very short Latin aliases such as "3D" and "9D" need token boundaries so
  // they do not match unrelated ad names or prose.
  if (/^[a-z0-9][a-z0-9 .+\-_/]{0,3}$/i.test(normalizedTerm)) {
    return new RegExp(
      `(^|[^a-z0-9])${escapeRegex(normalizedTerm)}([^a-z0-9]|$)`,
      "i"
    ).test(normalizedText);
  }

  return normalizedText.includes(normalizedTerm);
}

function configuredServiceTerms(serviceName, config = clinicConfig) {
  const normalizedTarget = normalizeServiceText(serviceName);
  const aliases = Array.isArray(config?.serviceAliases)
    ? config.serviceAliases
        .filter(
          (item) =>
            normalizeServiceText(item?.officialService) === normalizedTarget
        )
        .map((item) => normalizeServiceText(item?.alias))
        .filter(Boolean)
    : [];

  return [normalizeServiceText(serviceName), ...aliases].filter(Boolean);
}

function inferConfiguredServiceFromText(value, config = clinicConfig) {
  const normalizedText = normalizeServiceText(value);
  if (!normalizedText) return null;

  const matches = [];
  for (const service of Array.isArray(config?.services) ? config.services : []) {
    const serviceName =
      typeof service?.name === "string" ? service.name.trim() : "";
    if (!serviceName) continue;

    const matchedTerms = configuredServiceTerms(serviceName, config).filter(
      (term) => textContainsTerm(normalizedText, term)
    );
    if (matchedTerms.length > 0) {
      matches.push({ serviceName, matchedTerms });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].serviceName;

  // A combined configured service may legitimately contain the aliases of its
  // component services (for example "3D+9D"). Prefer that combined service only
  // when one of its matched terms fully covers every competing service term.
  const covering = matches.filter((candidate) =>
    candidate.matchedTerms.some((candidateTerm) =>
      matches.every((other) => {
        if (other === candidate) return true;
        return other.matchedTerms.some(
          (otherTerm) =>
            candidateTerm.length > otherTerm.length &&
            candidateTerm.includes(otherTerm)
        );
      })
    )
  );

  return covering.length === 1 ? covering[0].serviceName : null;
}

function cleanScoredTreatmentInterest(value, config = clinicConfig) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, 160);
  if (!cleaned) return null;

  const normalized = normalizeServiceText(cleaned);
  const exactService = (Array.isArray(config?.services) ? config.services : [])
    .map((service) => typeof service?.name === "string" ? service.name.trim() : "")
    .find((serviceName) => normalizeServiceText(serviceName) === normalized);
  if (exactService) return exactService;

  // The scoring prompt requires an exact configured name, but fail safely if a
  // provider returns extra wording. Resolve only when that wording still points
  // to one unambiguous configured service; otherwise preserve the current CRM
  // value instead of writing a free-form or multi-service string.
  return inferConfiguredServiceFromText(cleaned, config);
}

module.exports = {
  cleanScoredTreatmentInterest,
  configuredServiceTerms,
  inferConfiguredServiceFromText,
  normalizeServiceText,
};
