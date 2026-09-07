const pipelineRepo = require("../db/pipelineRepo");
const messagesRepo = require("../db/messagesRepo");
const clinicConfig = require("../config/clinicConfig");
const {
  getLeadTemperatureRuleProfile,
} = require("../config/leadTemperatureRuleProfiles");
const {
  isAllowedRuleTemperatureTransition,
} = require("../utils/leadTemperatureTransitions");

const CONTEXT_MESSAGE_LIMIT = 8;
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

function resolveRuleProfile(ruleProfile, businessType) {
  if (ruleProfile) return ruleProfile;
  if (businessType) return getLeadTemperatureRuleProfile({ businessType });
  return getLeadTemperatureRuleProfile(clinicConfig);
}

function isExplicitRejection(text, profile) {
  if (matchesAny(text, profile.absoluteRejectionPatterns)) return true;
  return (
    matchesAny(text, profile.declinePatterns) &&
    !matchesAny(text, profile.positiveContrastPatterns) &&
    !matchesAny(text, profile.unclearHotPatterns) &&
    !matchesAny(text, profile.alternativeContextPatterns)
  );
}

function hasHotIntent(text, profile) {
  return (
    matchesAny(text, profile.hotIntentPatterns) &&
    !matchesAny(text, profile.unclearHotPatterns) &&
    !matchesAny(text, profile.negatedHotPatterns)
  );
}

function configuredLocationMatches(text, locationNames) {
  return (locationNames || []).some((locationName) => {
    const normalizedLocation = normalizeText(locationName);
    return normalizedLocation && text.includes(normalizedLocation);
  });
}

function isContextAnswer(text, locationNames, profile) {
  const alternative = matchesAny(text, profile.alternativeContextPatterns);
  if (profile.alternativeOverridesNonConfirming && alternative) return true;

  if (
    matchesAny(text, profile.unclearHotPatterns) ||
    matchesAny(text, profile.nonConfirmingContextPatterns)
  ) {
    return false;
  }

  if (
    matchesAny(text, profile.contextConfirmPatterns) ||
    matchesAny(text, profile.contextDetailPatterns) ||
    matchesAny(text, profile.contextChoicePatterns)
  ) {
    return true;
  }

  return profile.allowConfiguredLocationAnswers && configuredLocationMatches(text, locationNames);
}

function classifyTemperatureMessage({
  messageText,
  previousBusinessMessage = "",
  // Backward-compatible argument name for existing tests/callers while the
  // surrounding codebase moves away from clinic-specific terminology.
  previousClinicMessage = "",
  locationNames = [],
  branchNames = [],
  ruleProfile = null,
  businessType = null,
}) {
  const profile = resolveRuleProfile(ruleProfile, businessType);
  const text = normalizeText(messageText);
  if (!text) return null;

  const absoluteRejection = matchesAny(text, profile.absoluteRejectionPatterns);
  const rejected = isExplicitRejection(text, profile);
  const hotIntent = hasHotIntent(text, profile);
  if (rejected && hotIntent) return null;

  const evidence = String(messageText).trim().slice(0, MAX_EVIDENCE_CHARS);
  if (rejected) {
    return {
      temperature: "cold",
      matchedRule: "explicit_rejection",
      rejectionStrength: absoluteRejection ? "absolute" : "standard",
      reason: "The customer explicitly declined or asked not to be contacted.",
      evidence,
    };
  }

  if (hotIntent && profile.hotMatchedRule) {
    return {
      temperature: "hot",
      matchedRule: profile.hotMatchedRule,
      reason: profile.hotReason,
      evidence,
    };
  }

  const previous = normalizeText(previousBusinessMessage || previousClinicMessage);
  const configuredLocations = locationNames.length ? locationNames : branchNames;
  if (
    previous &&
    profile.contextMatchedRule &&
    matchesAny(previous, profile.contextPromptPatterns) &&
    isContextAnswer(text, configuredLocations, profile)
  ) {
    return {
      temperature: "hot",
      matchedRule: profile.contextMatchedRule,
      reason: profile.contextReason,
      evidence,
    };
  }

  return null;
}

function createLeadTemperatureReviewer({
  pipelineRepository,
  messagesRepository,
  getLocationNames = null,
  // Keep the historical injection name so existing tests/integrations do not
  // need to migrate at the same time as the industry-aware rule layer.
  getBranchNames = null,
  getRuleProfile = () => getLeadTemperatureRuleProfile(clinicConfig),
  isAutoTemperatureEnabled = () => true,
}) {
  const resolveLocationNames = getLocationNames || getBranchNames || (() => []);

  return async function reviewLeadTemperatureForMessage(contactId, messageId, messageText) {
    if (!isAutoTemperatureEnabled()) {
      return { status: "skipped", reason: "auto-temperature-disabled" };
    }

    const lead = await pipelineRepository.getActiveLeadForContact(contactId);
    if (!lead) return { status: "skipped", reason: "no-active-lead" };
    if (lead.temperature_locked) {
      return { status: "skipped", reason: "staff-controlled" };
    }

    const ruleProfile = getRuleProfile();
    const locationNames = resolveLocationNames();
    let classification = classifyTemperatureMessage({
      messageText,
      locationNames,
      ruleProfile,
    });

    // Short answers such as "Saturday", "Puchong", "quotation", or "site
    // visit" only become Hot when the immediately preceding assistant message
    // was the active industry's relevant conversion/scheduling question.
    if (
      !classification &&
      isContextAnswer(normalizeText(messageText), locationNames, ruleProfile)
    ) {
      const messages = await messagesRepository.getMessagesForContact(
        contactId,
        CONTEXT_MESSAGE_LIMIT,
        false
      );
      const startedMessageId = Number(lead.started_message_id);
      const hasStartedMessage = Number.isSafeInteger(startedMessageId) && startedMessageId > 0;
      const journeyStartedAt = Date.parse(lead.created_at);
      const journeyMessages = messages.filter((message) => {
        if (hasStartedMessage) return Number(message.id) >= startedMessageId;
        const messageCreatedAt = Date.parse(message.created_at);
        return !Number.isNaN(journeyStartedAt) &&
          !Number.isNaN(messageCreatedAt) &&
          messageCreatedAt >= journeyStartedAt;
      });
      const currentIndex = journeyMessages.findIndex(
        (message) => Number(message.id) === Number(messageId)
      );
      const messagesBeforeCurrent = journeyMessages.slice(
        0,
        currentIndex < 0 ? journeyMessages.length : currentIndex
      );
      const previousMessage = messagesBeforeCurrent.at(-1);
      const previousBusinessMessage = previousMessage?.role === "assistant"
        ? previousMessage.content
        : "";

      classification = classifyTemperatureMessage({
        messageText,
        previousBusinessMessage,
        locationNames,
        ruleProfile,
      });
    }

    if (!classification) {
      return { status: "unchanged" };
    }

    // Re-check immediately before the write so disabling automatic temperature
    // while a context lookup is in flight cannot still apply a rule result.
    if (!isAutoTemperatureEnabled()) {
      return {
        status: "skipped",
        reason: "auto-temperature-disabled",
        classification,
      };
    }

    if (!isAllowedRuleTemperatureTransition(lead.temperature, classification)) {
      return {
        status: "unchanged",
        reason: "transition-not-allowed",
        classification,
      };
    }

    const updatedLead = await pipelineRepository.applyRuleBasedTemperature(
      lead.id,
      classification,
      lead.temperature
    );
    return updatedLead
      ? { status: "updated", lead: updatedLead, classification }
      : { status: "skipped", reason: "lead-changed", classification };
  };
}

const reviewLeadTemperatureForMessage = createLeadTemperatureReviewer({
  pipelineRepository: pipelineRepo,
  messagesRepository: messagesRepo,
  getLocationNames: () => (clinicConfig.branches || []).map((branch) => branch.name),
  getRuleProfile: () => getLeadTemperatureRuleProfile(clinicConfig),
  isAutoTemperatureEnabled: () => clinicConfig.leadScoring?.enabled === true,
});

module.exports = {
  classifyTemperatureMessage,
  createLeadTemperatureReviewer,
  reviewLeadTemperatureForMessage,
};
