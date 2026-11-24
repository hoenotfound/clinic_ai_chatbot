"use strict";

// Offline proposal only. Does not connect to a database or modify any files.
// Usage: node scripts/preview-neutro-prompt-consolidation.js < secure-config-export.json > candidate.json
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const proposal = require("./config-proposals/neutro-prompt-consolidation-20261124.json");
const keys = ["sop", "messagingStyle", "closingPlaybook"];
const fingerprint = (text) => createHash("md5").update(text, "utf8").digest("hex");

function previewConsolidation(config, plan = proposal) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.businessName || config.clinicName) !== plan.clinic) {
    throw new Error("Expected Neutro Sense clinic configuration");
  }
  for (const key of keys) {
    if (typeof config[key] !== "string" || fingerprint(config[key]) !== plan.expectedMd5[key]) {
      throw new Error("Stale or missing source section: " + key + "; re-review before applying");
    }
    if (typeof plan.replacement[key] !== "string" || !plan.replacement[key].trim() ||
        plan.replacement[key].length >= config[key].length) {
      throw new Error("Invalid shortened replacement: " + key);
    }
  }
  const candidate = { ...config };
  for (const key of keys) candidate[key] = plan.replacement[key];
  return candidate;
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const candidate = previewConsolidation(input);
    process.stdout.write(JSON.stringify(candidate, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  }
}
module.exports = { previewConsolidation, fingerprint };
