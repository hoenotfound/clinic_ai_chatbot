"use strict";
const config = require("../config/clinicConfig");
const { buildSystemPrompt } = require("./systemPrompt");
const { scopeNeutroKnowledge } = require("./scopedPromptKnowledge");

const faqLine = (faq) => "Q: " + faq.q + "\nA: " + faq.a;
const ruleLine = (rule) => "- " + rule;
const format = (items, render, fallback) =>
  Array.isArray(items) && items.length ? items.map(render).join("\n") : "- " + fallback;

function buildScopedReplyPrompt(options) {
  const original = buildSystemPrompt(options);
  if (options?.surface !== "conversation") return original;
  const knowledge = scopeNeutroKnowledge({
    config, conversationContext: options.conversationContext,
  });
  if (!knowledge.scoped) return original;

  const fullKnowledge = [
    "FREQUENTLY ASKED QUESTIONS:",
    format(config.faqs, faqLine, "No FAQs configured."),
    "RULES (never break these):",
    format(config.guardrails, ruleLine, "Do not invent business facts or confirmations."),
  ].join("\n\n");
  if (!original.includes(fullKnowledge)) return original;

  const selectedKnowledge = [
    "RULES (never break these):",
    format(knowledge.generalGuardrails, ruleLine, "Do not invent business facts or confirmations."),
    "FREQUENTLY ASKED QUESTIONS:",
    format(knowledge.generalFaqs, faqLine, "No general FAQs."),
    ...(knowledge.relevantGuardrails.length ?
      ["SERVICE-SPECIFIC SAFETY RULES:", knowledge.relevantGuardrails.map(ruleLine).join("\n")] : []),
    ...(knowledge.relevantFaqs.length ?
      ["SERVICE-SPECIFIC FAQs:", knowledge.relevantFaqs.map(faqLine).join("\n")] : []),
  ].join("\n\n");

  // A layout change in the source builder disables scoping automatically.
  return original.replace(fullKnowledge, selectedKnowledge);
}
module.exports = { buildScopedReplyPrompt };
