const pipelineRepo = require("../db/pipelineRepo");
const messagesRepo = require("../db/messagesRepo");
const clinicConfig = require("../config/clinicConfig");
const {
  getLeadTemperatureRuleProfile,
} = require("../config/leadTemperatureRuleProfiles");
const {
  evaluateLeadTemperatureMessage,
} = require("./leadTemperatureClassifier");
const {
  isAllowedRuleTemperatureTransition,
} = require("../utils/leadTemperatureTransitions");

const CONTEXT_MESSAGE_LIMIT = 8;

function resolveRuleProfile(ruleProfile, businessType) {
  if (ruleProfile) return ruleProfile;
  if (businessType) return getLeadTemperatureRuleProfile({ businessType });
  return getLeadTemperatureRuleProfile(clinicConfig);
}

function evaluateTemperatureMessage({
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
  const configuredLocations = locationNames.length ? locationNames : branchNames;

  return evaluateLeadTemperatureMessage({
    messageText,
    previousBusinessMessage: previousBusinessMessage || previousClinicMessage,
    locationNames: configuredLocations,
    ruleProfile: profile,
  });
}

function classifyTemperatureMessage(input) {
  return evaluateTemperatureMessage(input).classification;
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
    let evaluation = evaluateTemperatureMessage({
      messageText,
      locationNames,
      ruleProfile,
    });
    let classification = evaluation.classification;

    // The pure classifier tells orchestration when the current message looks
    // like a context-only answer. History is loaded only in that case, so the
    // automation layer no longer duplicates rule-matching logic.
    if (!classification && evaluation.shouldLoadContext) {
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

      evaluation = evaluateTemperatureMessage({
        messageText,
        previousBusinessMessage,
        locationNames,
        ruleProfile,
      });
      classification = evaluation.classification;
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
  evaluateTemperatureMessage,
  reviewLeadTemperatureForMessage,
};
