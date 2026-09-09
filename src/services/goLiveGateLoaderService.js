const configRepo = require("../db/configRepo");
const { evaluateClientSetup } = require("./clientSetupService");
const { evaluateGoLiveGate } = require("./goLiveGateService");
const {
  decorateOverview,
  setupStatus,
} = require("./setupStatusOverviewService");

async function loadGoLiveGate({ runChecks = false, baseUrl } = {}) {
  const rawOverview = runChecks
    ? await setupStatus.runAll({ requestBaseUrl: baseUrl })
    : await setupStatus.getOverview({ requestBaseUrl: baseUrl });
  const setupOverview = await decorateOverview(rawOverview);
  const config = configRepo.getConfig();
  const clientSetup = evaluateClientSetup(config);

  return evaluateGoLiveGate({
    config,
    clientSetup,
    setupOverview,
  });
}

module.exports = { loadGoLiveGate };
