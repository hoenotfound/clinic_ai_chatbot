const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getLeadTemperatureRuleProfile,
} = require("../src/config/leadTemperatureRuleProfiles");
const {
  evaluateLeadTemperatureMessage,
} = require("../src/services/leadTemperatureClassifier");

const renovationProfile = getLeadTemperatureRuleProfile({
  businessType: "home_renovation",
});
const clinicProfile = getLeadTemperatureRuleProfile({
  businessType: "aesthetic_clinic",
});
const genericProfile = getLeadTemperatureRuleProfile({
  businessType: "generic",
});

function evaluate(messageText, ruleProfile, extra = {}) {
  return evaluateLeadTemperatureMessage({
    messageText,
    ruleProfile,
    ...extra,
  });
}

test("classifier pipeline exposes a stable direct-Hot decision without leaking diagnostics into persistence data", () => {
  const result = evaluate(
    "Can you prepare a quotation for my kitchen cabinets?",
    renovationProfile
  );

  assert.equal(result.decision, "direct_hot");
  assert.equal(result.shouldLoadContext, false);
  assert.ok(result.matchedSignals.includes("hotIntent"));
  assert.deepEqual(Object.keys(result.classification).sort(), [
    "evidence",
    "matchedRule",
    "reason",
    "temperature",
  ]);
  assert.equal(result.classification.temperature, "hot");
  assert.equal(result.classification.matchedRule, "project_commitment");
});

test("research guard wins over overlapping renovation Hot vocabulary", () => {
  const result = evaluate("Do I need a site measurement?", renovationProfile);

  assert.equal(result.decision, "unchanged");
  assert.equal(result.classification, null);
  assert.equal(result.shouldLoadContext, false);
  assert.ok(result.matchedSignals.includes("hotIntent"));
  assert.ok(result.matchedSignals.includes("uncertaintyGuard"));
});

test("mixed renovation next-step choice requests context instead of being stolen by a negative matcher", () => {
  const withoutContext = evaluate(
    "Tak nak site visit, quotation boleh",
    renovationProfile
  );

  assert.equal(withoutContext.decision, "needs_context");
  assert.equal(withoutContext.classification, null);
  assert.equal(withoutContext.shouldLoadContext, true);
  assert.ok(withoutContext.matchedSignals.includes("contextChoice"));
  assert.ok(withoutContext.matchedSignals.includes("negatedHot"));

  const withContext = evaluate(
    "Tak nak site visit, quotation boleh",
    renovationProfile,
    {
      previousBusinessMessage:
        "Nak kami arrange site visit atau sediakan quotation?",
    }
  );

  assert.equal(withContext.decision, "context_hot");
  assert.equal(withContext.shouldLoadContext, false);
  assert.ok(withContext.matchedSignals.includes("contextPrompt"));
  assert.equal(withContext.classification.temperature, "hot");
  assert.equal(
    withContext.classification.matchedRule,
    "project_next_step_confirmation"
  );
});

test("explicit rejection stage is deterministic for standard and absolute endings", () => {
  const standard = evaluate(
    "No thanks, I am not interested.",
    renovationProfile
  );
  assert.equal(standard.decision, "explicit_rejection");
  assert.equal(standard.classification.temperature, "cold");
  assert.equal(standard.classification.rejectionStrength, "standard");

  const absolute = evaluate("The project is cancelled.", renovationProfile);
  assert.equal(absolute.decision, "explicit_rejection");
  assert.equal(absolute.classification.temperature, "cold");
  assert.equal(absolute.classification.rejectionStrength, "absolute");
  assert.ok(absolute.matchedSignals.includes("absoluteRejection"));
});

test("clinic keeps historical non-confirming precedence for rejected scheduling times", () => {
  const result = evaluate(
    "Saturday can't, but Sunday works for me.",
    clinicProfile,
    {
      previousBusinessMessage: "Which day would you like to come to the clinic?",
    }
  );

  assert.equal(result.classification, null);
  assert.equal(result.shouldLoadContext, false);
  assert.equal(result.decision, "unchanged");
  assert.ok(result.matchedSignals.includes("alternativeContext"));
  assert.ok(result.matchedSignals.includes("nonConfirmingContext"));
});

test("generic profile remains conservative through the same classifier pipeline", () => {
  const booking = evaluate(
    "Can I book an appointment tomorrow?",
    genericProfile
  );
  const renovation = evaluate(
    "Can you arrange a site visit and quotation?",
    genericProfile
  );
  const stop = evaluate("Please stop messaging me.", genericProfile);

  assert.equal(booking.decision, "unchanged");
  assert.equal(booking.classification, null);
  assert.equal(renovation.decision, "unchanged");
  assert.equal(renovation.classification, null);
  assert.equal(stop.decision, "explicit_rejection");
  assert.equal(stop.classification.temperature, "cold");
  assert.equal(stop.classification.rejectionStrength, "absolute");
});

test("empty messages short-circuit before any rule stage", () => {
  const result = evaluate("   ", renovationProfile);

  assert.deepEqual(result, {
    classification: null,
    shouldLoadContext: false,
    decision: "empty_message",
    matchedSignals: [],
  });
});
