const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const {
  createLeadTemperatureReviewer,
  reviewLeadTemperatureForMessage,
} = require("../src/services/leadTemperatureAutomation");

test("production rule reviewer does nothing while automatic lead temperature is disabled", async (t) => {
  const previousLeadScoring = clinicConfig.leadScoring;
  t.after(() => {
    clinicConfig.leadScoring = previousLeadScoring;
  });

  clinicConfig.leadScoring = {
    ...(previousLeadScoring || {}),
    enabled: false,
  };

  assert.deepEqual(
    await reviewLeadTemperatureForMessage(999999, 999999, "I want to book tomorrow"),
    { status: "skipped", reason: "auto-temperature-disabled" }
  );
});

test("turning automation off while a rule review is in flight prevents the temperature write", async () => {
  let enabled = true;
  let applyCalls = 0;

  const reviewer = createLeadTemperatureReviewer({
    pipelineRepository: {
      getActiveLeadForContact: async () => {
        enabled = false;
        return { id: 12, temperature: "warm", temperature_locked: false };
      },
      applyRuleBasedTemperature: async () => {
        applyCalls += 1;
        return { id: 12, temperature: "hot" };
      },
    },
    messagesRepository: {
      getMessagesForContact: async () => [],
    },
    getBranchNames: () => [],
    isAutoTemperatureEnabled: () => enabled,
  });

  const result = await reviewer(5, 10, "I want to book tomorrow");

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "auto-temperature-disabled");
  assert.equal(result.classification?.temperature, "hot");
  assert.equal(applyCalls, 0);
});
