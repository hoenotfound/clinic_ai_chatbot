"use strict";

// Conservative, deterministic selection of clinic knowledge for one verified
// treatment. Anything ambiguous, shared, or not recognisably service-specific
// stays in the prompt. No language model, API call or user-controlled regex.
function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().trim();
}
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
function labelMatches(text, label) {
  const haystack = normalize(text);
  const needle = normalize(label);
  if (!needle || !haystack) return false;
  if (/^[a-z0-9]+$/.test(needle)) {
    return new RegExp("(^|[^a-z0-9])" + needle + "($|[^a-z0-9])", "u").test(haystack);
  }
  return haystack.includes(needle);
}
function canonicalServiceKey(value) {
  return normalize(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}
function serviceLabels(service, aliases) {
  const name = String(service?.name || "").trim();
  if (!name) return [];
  const labels = [name];
  const shortParts = name.split(/[\s/|,，、]+/u).filter(Boolean);
  for (const part of shortParts) {
    if (part.length >= 3 || /^[39]\s*d$/i.test(part)) labels.push(part);
  }
  if (/3\s*d/iu.test(name)) labels.push("3D", "小颜术", "小顏術");
  if (/9\s*d/iu.test(name)) labels.push("9D", "逆龄", "逆齡");
  if (/骨盆/u.test(name)) labels.push("骨盆", "pelvic", "pelvis");
  if (/脉冲波/u.test(name)) labels.push("脉冲波");
  if (/子宫/u.test(name)) labels.push("子宫", "子宮");
  if (/胸部|乳腺/u.test(name)) labels.push("乳腺护理", "乳腺護理", "草药胸部", "草藥胸部");
  const key = canonicalServiceKey(name);
  for (const alias of aliases || []) {
    if (canonicalServiceKey(alias?.officialService) !== key) continue;
    const value = String(alias?.alias || "").trim();
    const chinese = /[\p{Script=Han}]/u.test(value);
    if (value.length >= (chinese ? 3 : 5) || /^[39]\s*d$/i.test(value)) labels.push(value);
  }
  return unique(labels);
}
function ownersForText(text, services, aliases) {
  const matches = [];
  for (const service of services || []) {
    if (serviceLabels(service, aliases).some((label) => labelMatches(text, label))) {
      matches.push(String(service.name));
    }
  }
  return unique(matches);
}
function scopeNeutroKnowledge({ config, conversationContext } = {}) {
  const faqs = Array.isArray(config?.faqs) ? config.faqs : [];
  const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
  const services = Array.isArray(config?.services) ? config.services : [];
  const aliases = Array.isArray(config?.serviceAliases) ? config.serviceAliases : [];
  const full = {
    scoped: false, generalFaqs: faqs, relevantFaqs: [],
    generalGuardrails: guardrails, relevantGuardrails: [],
  };
  const brand = String(config?.businessName || config?.clinicName || "");
  if (!/neutro[\s-]*sense/i.test(brand)) return full;
  if (process.env.NEUTRO_PROMPT_KNOWLEDGE_SCOPING === "off") return full;
  const selected = Array.isArray(conversationContext?.relevantServiceNames)
    ? unique(conversationContext.relevantServiceNames.map(String))
    : [];
  if (selected.length !== 1 || conversationContext?.broadPriceIntent === true ||
      conversationContext?.serviceDiscoveryIntent === true) return full;
  const serviceKey = canonicalServiceKey(selected[0]);
  if (!services.some((service) => canonicalServiceKey(service?.name) === serviceKey)) return full;
  // If the current customer message names a different treatment, or several
  // treatments, keep full knowledge rather than relying on a stale CRM/ad hint.
  const currentOwners = ownersForText(
    conversationContext?.currentCustomerText || "", services, aliases
  );
  if (currentOwners.some((name) => canonicalServiceKey(name) !== serviceKey)) return full;

  const partition = (entries, render) => {
    const general = [], relevant = [];
    for (const entry of entries) {
      const owners = ownersForText(render(entry), services, aliases);
      if (owners.length !== 1) {
        // Include all universal instructions and multi-treatment comparisons.
        general.push(entry);
      } else if (canonicalServiceKey(owners[0]) === serviceKey) {
        relevant.push(entry);
      }
      // Only a clearly exclusive FAQ/rule for ANOTHER service is omitted.
    }
    return { general, relevant };
  };
  const faqParts = partition(faqs, (faq) =>
    String(faq?.q || "") + "\n" + String(faq?.a || ""));
  const ruleParts = partition(guardrails, (rule) => String(rule || ""));
  return {
    scoped: true,
    generalFaqs: faqParts.general,
    relevantFaqs: faqParts.relevant,
    generalGuardrails: ruleParts.general,
    relevantGuardrails: ruleParts.relevant,
  };
}
module.exports = { scopeNeutroKnowledge, ownersForText, serviceLabels };
