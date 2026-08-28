const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadTemperatureReviewer,
  hasMeaningfulCustomerMessage,
  shouldApplyAutomaticTemperature,
} = require("../src/services/leadTemperatureAutomation");

test("automatic temperature only changes an open Warm lead on decisive high-confidence evidence", () => {
  const lead = { temperature: "warm", is_closed: false };
  const decisiveHot = {
    temperature: "hot",
    confidence: "high",
    enoughInformation: true,
  };

  assert.equal(shouldApplyAutomaticTemperature(lead, decisiveHot), true);
  assert.equal(shouldApplyAutomaticTemperature({ ...lead, temperature: "hot" }, decisiveHot), false);
  assert.equal(shouldApplyAutomaticTemperature(lead, { ...decisiveHot, confidence: "medium" }), false);
  assert.equal(shouldApplyAutomaticTemperature(lead, { ...decisiveHot, enoughInformation: false }), false);
  assert.equal(shouldApplyAutomaticTemperature(lead, { ...decisiveHot, temperature: "warm" }), false);
  assert.equal(shouldApplyAutomaticTemperature({ ...lead, is_closed: true }, decisiveHot), false);
});

test("media placeholders are not treated as customer evidence", () => {
  assert.equal(hasMeaningfulCustomerMessage([
    { role: "user", content: "📷 [Patient sent a photo]" },
    { role: "assistant", content: "How can I help?" },
  ]), false);
  assert.equal(hasMeaningfulCustomerMessage([
    { role: "user", content: "🎤 I want to book tomorrow" },
  ]), true);
});

test("reviewer applies a qualifying Hot or Cold result", async () => {
  const applied = [];
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 4, temperature: "warm", is_closed: false }),
      applyAutomaticTemperature: async (leadId, suggestion) => {
        applied.push({ leadId, suggestion });
        return { id: leadId, temperature: suggestion.temperature };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [{ role: "user", content: "No thanks, I am not interested." }],
    },
    suggestTemperature: async () => ({
      temperature: "cold",
      confidence: "high",
      enoughInformation: true,
      reason: "The customer explicitly said they are not interested.",
    }),
  });

  const result = await reviewer(12);

  assert.equal(result.status, "updated");
  assert.equal(result.lead.temperature, "cold");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].leadId, 4);
});

test("reviewer leaves Warm unchanged until the evidence is strong enough", async () => {
  let applyCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 8, temperature: "warm", is_closed: false }),
      applyAutomaticTemperature: async () => {
        applyCalls += 1;
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [{ role: "user", content: "How much is it?" }],
    },
    suggestTemperature: async () => ({
      temperature: "warm",
      confidence: "low",
      enoughInformation: false,
      reason: "The customer only asked about price.",
    }),
  });

  const result = await reviewer(13);

  assert.equal(result.status, "unchanged");
  assert.equal(applyCalls, 0);
});

test("reviewer does not call the AI for staff-set Hot or Cold leads", async () => {
  let downstreamCalls = 0;
  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => ({ id: 9, temperature: "hot", is_closed: false }),
    },
    messagesRepository: {
      getMessagesForContact: async () => {
        downstreamCalls += 1;
        return [];
      },
    },
    suggestTemperature: async () => {
      downstreamCalls += 1;
      return null;
    },
  });

  const result = await reviewer(14);

  assert.deepEqual(result, { status: "skipped", reason: "not-warm" });
  assert.equal(downstreamCalls, 0);
});
