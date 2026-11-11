"use strict";

const clinicConfig = require("../config/clinicConfig");

// The Inbox filter is presentation-only: resolve exact configured aliases,
// without rewriting historical lead records or guessing from free-form text.
function treatmentKey(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
}

function createInboxTreatmentResolver(config = clinicConfig) {
  const official = new Map();
  for (const service of Array.isArray(config?.services) ? config.services : []) {
    const label = typeof service?.name === "string" ? service.name.trim() : "";
    const key = treatmentKey(label);
    if (key && !official.has(key)) official.set(key, label);
  }

  const aliases = new Map();
  const ambiguous = new Set();
  for (const entry of Array.isArray(config?.serviceAliases) ? config.serviceAliases : []) {
    const aliasKey = treatmentKey(entry?.alias);
    const officialKey = treatmentKey(entry?.officialService);
    const canonical = official.get(officialKey);
    if (!aliasKey || !canonical || official.has(aliasKey)) continue;
    const previous = aliases.get(aliasKey);
    if (previous && previous !== canonical) ambiguous.add(aliasKey);
    else aliases.set(aliasKey, canonical);
  }
  for (const key of ambiguous) aliases.delete(key);

  return (value) => {
    const original = typeof value === "string" ? value.trim().slice(0, 160) : "";
    const key = treatmentKey(original);
    if (!key) return { key: "", label: "" };
    const label = official.get(key) || aliases.get(key) || original;
    return { key: treatmentKey(label), label };
  };
}

module.exports = { treatmentKey, createInboxTreatmentResolver };
