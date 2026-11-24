"use strict";

const { createHash } = require("node:crypto");
const fingerprint = value => createHash("md5").update(value, "utf8").digest("hex");

// A proposal is supplied only by the internal benchmark. Ordinary runtime
// calls have no proposal and retain the existing prompt exactly.
function resolveCompactConversationPolicy(config, proposal) {
  if (!proposal || config.businessType !== "tcm_clinic" ||
      (config.businessName || config.clinicName) !== proposal.clinic) return null;
  const guards = config.guardrails, triggers = config.escalation?.outOfScopeTriggers;
  if (!Array.isArray(guards) || !Array.isArray(triggers) ||
      fingerprint(guards.join("\n")) !== proposal.expectedMd5?.guardrails ||
      fingerprint(triggers.join("\n")) !== proposal.expectedMd5?.triggers) return null;
  if (!Array.isArray(proposal.guardrails) || !proposal.guardrails.length ||
      !Array.isArray(proposal.triggers) || !proposal.triggers.length ||
      ![...proposal.guardrails, ...proposal.triggers].every(v => typeof v === "string" && v.trim())) return null;
  return proposal;
}

// Do not route replies or infer interest here. Only omit reviewed, single-service
// FAQ examples about OTHER services on a directly identified current topic.
// Keep all general, clinical, comparison, unknown and edited FAQs, and all FAQs
// when context is indirect/ambiguous. Matching the entire FAQ prevents stale
// metadata silently dropping a newly edited answer.
function selectCompactFAQs(faqs, context, policy) {
  if (!Array.isArray(faqs) || !policy || context?.serviceSource !== "current_customer" ||
      context?.relevantServiceNames?.length !== 1 || context.serviceDiscoveryIntent ||
      context.broadPriceIntent || context.schedulingIntent || context.contactIntent) return faqs;
  const service = context.relevantServiceNames[0];
  const scopes = policy.faqScopes || {};
  if (!Object.values(scopes).includes(service)) return faqs;
  return faqs.filter(faq => {
    if (typeof faq?.q !== "string" || typeof faq?.a !== "string") return true;
    const scope = scopes[fingerprint(faq.q + "\n" + faq.a)];
    return !scope || scope === service;
  });
}
// Runtime opt-in is clinic-specific and fails closed when an administrator
// edits any reviewed source section. Never write back to the stored config.
function resolveProductionCompactPolicy(config, plan = require("../../scripts/config-proposals/neutro-prompt-consolidation-stage2.json"),
  stage1 = require("../../scripts/config-proposals/neutro-prompt-consolidation-20261124.json")) {
  if (config.promptOptimization?.neutroCompactV2 !== true) return null;
  if (stage1.clinic !== plan.clinic) return null;
  if (!resolveCompactConversationPolicy(config, plan)) return null;
  for (const key of ["sop", "messagingStyle", "closingPlaybook"]) {
    if (typeof config[key] !== "string" ||
        fingerprint(config[key]) !== stage1.expectedMd5[key]) return null;
  }
  return {...plan, replacement: stage1.replacement};
}
module.exports = { resolveCompactConversationPolicy, selectCompactFAQs, resolveProductionCompactPolicy };
