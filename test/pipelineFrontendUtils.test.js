const test = require("node:test");
const assert = require("node:assert/strict");

const form = {
  stageId: "2",
  temperature: "warm",
  temperatureLocked: false,
  branchName: "Puchong",
  ownerUsername: "",
  treatmentInterest: "HIFU",
  estimatedValue: "1200",
  source: "WhatsApp",
  campaignName: "",
  appointmentStatus: "none",
  appointmentAt: "",
  nextFollowUpAt: "",
  lostReason: "",
  marketingConsent: "unknown",
  notes: "Call tomorrow",
};

test("lead detail saves omit temperature unless staff changed its controls", async () => {
  const { buildLeadUpdatePayload } = await import(
    "../portal-frontend/src/components/pipeline/pipelineUtils.js"
  );

  const ordinarySave = buildLeadUpdatePayload(form);
  assert.equal(Object.hasOwn(ordinarySave, "temperature"), false);
  assert.equal(Object.hasOwn(ordinarySave, "temperatureLocked"), false);
  assert.equal(ordinarySave.branchName, "Puchong");

  const temperatureSave = buildLeadUpdatePayload(form, { includeTemperature: true });
  assert.equal(temperatureSave.temperature, "warm");
  assert.equal(temperatureSave.temperatureLocked, false);
});
