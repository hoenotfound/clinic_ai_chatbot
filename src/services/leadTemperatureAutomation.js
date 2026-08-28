const pipelineRepo = require("../db/pipelineRepo");
const messagesRepo = require("../db/messagesRepo");
const { suggestLeadTemperature } = require("./leadTemperatureService");

const MESSAGE_LIMIT = 30;
const CUSTOMER_PLACEHOLDER = /^(?:📎|🎤|📷)?\s*\[Patient (?:sent|message)/i;

function hasMeaningfulCustomerMessage(messages) {
  return (messages || []).some((message) => {
    if (message.role !== "user") return false;
    const content = String(message.content || "").trim();
    return content && !CUSTOMER_PLACEHOLDER.test(content);
  });
}

function shouldApplyAutomaticTemperature(lead, suggestion) {
  return (
    lead?.temperature === "warm" &&
    lead?.is_closed !== true &&
    suggestion?.enoughInformation === true &&
    suggestion?.confidence === "high" &&
    (suggestion?.temperature === "hot" || suggestion?.temperature === "cold")
  );
}

function createLeadTemperatureReviewer({
  pipelineRepository,
  messagesRepository,
  suggestTemperature,
}) {
  return async function reviewLeadTemperatureForContact(contactId) {
    const lead = await pipelineRepository.getActiveLeadForContact(contactId);
    if (!lead || lead.temperature !== "warm") {
      return { status: "skipped", reason: "not-warm" };
    }

    const messages = await messagesRepository.getMessagesForContact(
      contactId,
      MESSAGE_LIMIT,
      false
    );
    if (!hasMeaningfulCustomerMessage(messages)) {
      return { status: "skipped", reason: "no-customer-evidence" };
    }

    const suggestion = await suggestTemperature({ messages, lead });
    if (!shouldApplyAutomaticTemperature(lead, suggestion)) {
      return { status: "unchanged", suggestion };
    }

    // The repository repeats the Warm check in the UPDATE itself. If a staff
    // member changes the lead while the AI request is running, their choice wins.
    const updatedLead = await pipelineRepository.applyAutomaticTemperature(
      lead.id,
      suggestion
    );
    return updatedLead
      ? { status: "updated", lead: updatedLead, suggestion }
      : { status: "skipped", reason: "lead-changed", suggestion };
  };
}

const reviewLeadTemperatureForContact = createLeadTemperatureReviewer({
  pipelineRepository: pipelineRepo,
  messagesRepository: messagesRepo,
  suggestTemperature: suggestLeadTemperature,
});

module.exports = {
  createLeadTemperatureReviewer,
  hasMeaningfulCustomerMessage,
  reviewLeadTemperatureForContact,
  shouldApplyAutomaticTemperature,
};
