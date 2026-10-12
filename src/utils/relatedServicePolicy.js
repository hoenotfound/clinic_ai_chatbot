"use strict";

const { inferConfiguredServiceFromText } = require("./serviceInterest");

const normalize = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase();

function relatedMediaTargets(primary, resultMedia = []) {
  const service = normalize(primary);
  if (!service) return [];
  return (Array.isArray(resultMedia) ? resultMedia : [])
    .filter((entry) =>
      entry?.enabled === true &&
      Array.isArray(entry?.relatedServices) &&
      entry.relatedServices.some((candidate) => normalize(candidate) === service)
    )
    .map((entry) => String(entry.service || "").trim())
    .filter(Boolean);
}

function isRelatedTreatment(primary, related, resultMedia = []) {
  return relatedMediaTargets(primary, resultMedia)
    .some((name) => normalize(name) === normalize(related));
}

function configuredServiceMention(text, services, aliases) {
  return inferConfiguredServiceFromText(text, {
    services: Array.isArray(services) ? services : [],
    serviceAliases: Array.isArray(aliases) ? aliases : [],
  });
}

// An AI-selected treatment is not permission to quote a related treatment's
// package price. The current explicit customer topic overrides history;
// otherwise, a recent customer-named topic protects a bare "price?" follow-up.
function relatedPricingConflict({
  customerText, treatment, conversationHistory = [], services = [], serviceAliases = [],
  resultMedia = [],
} = {}) {
  const check = (text) => {
    const primary = configuredServiceMention(text, services, serviceAliases);
    if (primary) return { found: true, conflicts: isRelatedTreatment(primary, treatment, resultMedia) };
    return { found: false, conflicts: false };
  };
  const current = check(customerText);
  if (current.found) return current.conflicts;

  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  let inspected = 0;
  for (let index = history.length - 1; index >= 0 && inspected < 8; index -= 1) {
    const entry = history[index];
    if (entry?.role !== "user" || typeof entry.content !== "string") continue;
    if (entry.content.trim() === String(customerText || "").trim()) continue;
    inspected += 1;
    const prior = check(entry.content);
    if (prior.found) return prior.conflicts;
  }
  return false;
}

module.exports = {
  relatedMediaTargets, isRelatedTreatment, configuredServiceMention, relatedPricingConflict,
};
