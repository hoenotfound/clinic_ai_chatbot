const leadAttributionRepo = require("../db/leadAttributionRepo");

const FIELD_LIMITS = Object.freeze({
  headline: 500,
  body: 1200,
});

function cleanContextText(value, maxLength) {
  if (value == null) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

function normalizeMetaAdReplyContext(row) {
  if (!row || row.source !== "meta_ads") return null;

  const headline = cleanContextText(row.headline, FIELD_LIMITS.headline);
  const body = cleanContextText(row.body, FIELD_LIMITS.body);

  // Only customer-visible creative copy may influence AI reply context.
  // Internal ad/campaign/ad-set names are intentionally excluded. If Meta did
  // not supply usable headline/body copy, return no reply context at all.
  return headline || body
    ? { headline, body }
    : null;
}

function normalizeServiceTerm(value) {
  return String(value || "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactServiceTerm(value) {
  return normalizeServiceTerm(value).replace(/\s+/g, "");
}

function canonicalConfiguredServiceName(value, services = []) {
  const target = normalizeServiceTerm(value);
  if (!target) return null;

  const exact = (services || []).filter(
    (service) => normalizeServiceTerm(service?.name) === target
  );
  if (exact.length === 1) return String(exact[0].name).trim();
  if (exact.length > 1) return null;

  const compactTarget = compactServiceTerm(value);
  const compact = (services || []).filter(
    (service) => compactServiceTerm(service?.name) === compactTarget
  );
  return compact.length === 1 ? String(compact[0].name).trim() : null;
}

function splitConfiguredAlias(value) {
  return String(value || "")
    .split(/[\/|;\n]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function serviceTermAppearsInCreative(term, creativeText) {
  const normalizedTerm = normalizeServiceTerm(term);
  const normalizedText = normalizeServiceTerm(creativeText);
  if (!normalizedTerm || !normalizedText) return false;

  const compactTerm = normalizedTerm.replace(/\s+/g, "");
  if (compactTerm.length < 2) return false;

  const paddedText = ` ${normalizedText} `;
  if (paddedText.includes(` ${normalizedTerm} `)) return true;

  // Preserve alphanumeric boundaries for English/BM service names and aliases.
  if (/^[a-z0-9 ]+$/u.test(normalizedTerm)) {
    const words = normalizedTerm.split(" ").filter(Boolean);
    const compactPattern = words.join("\\s*");
    return new RegExp(
      `(^|[^a-z0-9])${compactPattern}([^a-z0-9]|$)`,
      "i"
    ).test(normalizedText);
  }

  // Mixed Latin/CJK names such as "3D 小颜术" should match "3D小颜术".
  const compactText = normalizedText.replace(/\s+/g, "");
  return compactText.includes(compactTerm);
}

function configuredServiceTerms(service, services, aliases) {
  const canonical = String(service?.name || "").trim();
  if (!canonical) return [];

  const terms = [canonical];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const target = canonicalConfiguredServiceName(alias?.officialService, services);
    if (target !== canonical) continue;
    terms.push(...splitConfiguredAlias(alias?.alias));
  }
  return [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))];
}

/**
 * Deterministically maps Meta headline/body creative to exactly one configured
 * service. This is a trust boundary for outbound Before/After automation:
 * semantic model guesses are never sufficient. Ambiguous or unrecognized
 * creative fails closed and returns null.
 */
function resolveMetaAdCreativeService(
  context,
  services = [],
  aliases = []
) {
  if (!context || typeof context !== "object") return null;

  const headline = cleanContextText(context.headline, FIELD_LIMITS.headline);
  const body = cleanContextText(context.body, FIELD_LIMITS.body);
  const creativeText = [headline, body].filter(Boolean).join(" ");
  if (!creativeText) return null;

  const matched = (Array.isArray(services) ? services : [])
    .map((service) => {
      const canonical = String(service?.name || "").trim();
      if (!canonical) return null;
      const terms = configuredServiceTerms(service, services, aliases);
      return terms.some((term) => serviceTermAppearsInCreative(term, creativeText))
        ? canonical
        : null;
    })
    .filter(Boolean);

  const unique = [...new Set(matched)];
  return unique.length === 1 ? unique[0] : null;
}

async function loadMetaAdReplyContext(
  contactId,
  { repo = leadAttributionRepo } = {}
) {
  const id = Number(contactId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const row = await repo.getForContactCurrentLead(id);
  return normalizeMetaAdReplyContext(row);
}

module.exports = {
  FIELD_LIMITS,
  cleanContextText,
  normalizeMetaAdReplyContext,
  resolveMetaAdCreativeService,
  serviceTermAppearsInCreative,
  loadMetaAdReplyContext,
};
