const MAX_EVIDENCE_CHARS = 200;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function configuredLocationMatches(text, locationNames) {
  return (locationNames || []).some((locationName) => {
    const normalizedLocation = normalizeText(locationName);
    return normalizedLocation && text.includes(normalizedLocation);
  });
}

function collectSignals(text, locationNames, profile) {
  return {
    absoluteRejection: matchesAny(text, profile.absoluteRejectionPatterns),
    decline: matchesAny(text, profile.declinePatterns),
    positiveContrast: matchesAny(text, profile.positiveContrastPatterns),
    uncertaintyGuard: matchesAny(text, profile.unclearHotPatterns),
    negatedHot: matchesAny(text, profile.negatedHotPatterns),
    hotIntent: matchesAny(text, profile.hotIntentPatterns),
    alternativeContext: matchesAny(text, profile.alternativeContextPatterns),
    contextChoice: matchesAny(text, profile.contextChoicePatterns),
    contextConfirmation: matchesAny(text, profile.contextConfirmPatterns),
    contextDetail: matchesAny(text, profile.contextDetailPatterns),
    nonConfirmingContext: matchesAny(text, profile.nonConfirmingContextPatterns),
    configuredLocation: configuredLocationMatches(text, locationNames),
  };
}

function isExplicitRejection(signals) {
  if (signals.absoluteRejection) return true;
  return (
    signals.decline &&
    !signals.positiveContrast &&
    !signals.uncertaintyGuard &&
    !signals.alternativeContext
  );
}

function hasDirectHotIntent(signals) {
  return signals.hotIntent && !signals.uncertaintyGuard && !signals.negatedHot;
}

function isContextAnswer(signals, profile) {
  // Renovation can accept a rejected proposed time/next step plus a clear
  // replacement ("Saturday can't, but Sunday works" or "quote instead").
  // Clinic deliberately keeps the historical non-confirming ordering.
  if (
    profile.alternativeOverridesNonConfirming &&
    (signals.alternativeContext || signals.contextChoice)
  ) {
    return true;
  }

  if (signals.uncertaintyGuard || signals.nonConfirmingContext) {
    return false;
  }

  if (
    signals.alternativeContext ||
    signals.contextConfirmation ||
    signals.contextDetail ||
    signals.contextChoice
  ) {
    return true;
  }

  return profile.allowConfiguredLocationAnswers && signals.configuredLocation;
}

function matchedSignalNames(signals) {
  return Object.entries(signals)
    .filter(([, matched]) => matched === true)
    .map(([name]) => name);
}

function evaluateLeadTemperatureMessage({
  messageText,
  previousBusinessMessage = "",
  locationNames = [],
  ruleProfile,
}) {
  if (!ruleProfile) {
    throw new TypeError("ruleProfile is required for lead temperature evaluation");
  }

  const text = normalizeText(messageText);
  if (!text) {
    return {
      classification: null,
      shouldLoadContext: false,
      decision: "empty_message",
      matchedSignals: [],
    };
  }

  const signals = collectSignals(text, locationNames, ruleProfile);
  const rejected = isExplicitRejection(signals);
  const hotIntent = hasDirectHotIntent(signals);
  const contextAnswer = isContextAnswer(signals, ruleProfile);
  const previous = normalizeText(previousBusinessMessage);
  const contextPrompt = Boolean(
    previous &&
    ruleProfile.contextMatchedRule &&
    matchesAny(previous, ruleProfile.contextPromptPatterns)
  );
  const matchedSignals = matchedSignalNames({ ...signals, contextPrompt });
  const evidence = String(messageText).trim().slice(0, MAX_EVIDENCE_CHARS);

  // Decision precedence is intentionally explicit. New industries should add
  // profile data, not reorder these stages inside their own regex collections.
  if (rejected && hotIntent) {
    return {
      classification: null,
      shouldLoadContext: contextAnswer && Boolean(ruleProfile.contextMatchedRule),
      decision: "conflicting_direct_signals",
      matchedSignals,
    };
  }

  if (rejected) {
    return {
      classification: {
        temperature: "cold",
        matchedRule: "explicit_rejection",
        rejectionStrength: signals.absoluteRejection ? "absolute" : "standard",
        reason: "The customer explicitly declined or asked not to be contacted.",
        evidence,
      },
      shouldLoadContext: false,
      decision: "explicit_rejection",
      matchedSignals,
    };
  }

  if (hotIntent && ruleProfile.hotMatchedRule) {
    return {
      classification: {
        temperature: "hot",
        matchedRule: ruleProfile.hotMatchedRule,
        reason: ruleProfile.hotReason,
        evidence,
      },
      shouldLoadContext: false,
      decision: "direct_hot",
      matchedSignals,
    };
  }

  if (contextPrompt && contextAnswer) {
    return {
      classification: {
        temperature: "hot",
        matchedRule: ruleProfile.contextMatchedRule,
        reason: ruleProfile.contextReason,
        evidence,
      },
      shouldLoadContext: false,
      decision: "context_hot",
      matchedSignals,
    };
  }

  if (contextAnswer && ruleProfile.contextMatchedRule) {
    return {
      classification: null,
      shouldLoadContext: true,
      decision: "needs_context",
      matchedSignals,
    };
  }

  return {
    classification: null,
    shouldLoadContext: false,
    decision: "unchanged",
    matchedSignals,
  };
}

module.exports = {
  evaluateLeadTemperatureMessage,
  normalizeText,
};
