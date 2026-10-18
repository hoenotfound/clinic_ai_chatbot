"use strict";

// Malaysian customers commonly write "盆骨" instead of "骨盆".
// Only add spelling variants when the clinic explicitly configures
// the canonical 骨盆调理 treatment. No CRM/ad inference is introduced.
function withPelvicSpellingAliases(services = [], aliases = []) {
  const existing = Array.isArray(aliases) ? aliases : [];
  if (!(Array.isArray(services) && services.some(s => s?.name === "骨盆调理"))) {
    return existing;
  }
  const configured = new Set(existing
    .filter(a => a?.officialService === "骨盆调理")
    .map(a => String(a.alias || "").normalize("NFKC").trim()));
  const extra = ["盆骨", "盆骨调整", "盆骨矫正", "盆骨调理"]
    .filter(alias => !configured.has(alias))
    .map(alias => ({ alias, officialService: "骨盆调理" }));
  return extra.length ? [...existing, ...extra] : existing;
}

module.exports = { withPelvicSpellingAliases };
