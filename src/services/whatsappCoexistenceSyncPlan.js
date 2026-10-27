"use strict";

// Pure, non-sending plan for Meta's one-time WhatsApp Business App data sync.
// Run the actual requests only after verified Embedded Signup, the signed
// receiving webhook and the persistent importer are ready.
function prepareCoexistenceSyncPlan({
  phoneNumberId, onboardingCompletedAt, historyConsent,
  authorized = false, receiverReady = false, importerReady = false,
  now = new Date(),
} = {}) {
  if (!/^\d+$/.test(String(phoneNumberId || ""))) {
    throw Error("A verified numeric secondary phone ID is required.");
  }
  const completed = new Date(onboardingCompletedAt);
  const clock = new Date(now);
  if (!Number.isFinite(completed.getTime()) || !Number.isFinite(clock.getTime()) ||
      clock.getTime() < completed.getTime()) {
    throw Error("A valid completed onboarding timestamp is required.");
  }
  const ageMs = clock.getTime() - completed.getTime();
  const allowed = authorized === true && receiverReady === true &&
    importerReady === true && ageMs < 24 * 60 * 60 * 1000;
  const requests = [
    { path: `/${phoneNumberId}/smb_app_data`,
      body: { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" } },
  ];
  if (historyConsent === true) {
    requests.push({ path: `/${phoneNumberId}/smb_app_data`,
      body: { messaging_product: "whatsapp", sync_type: "history" } });
  }
  return {
    eligibleToRequest: allowed,
    expired: ageMs >= 24 * 60 * 60 * 1000,
    requests: allowed ? requests : [],
    requiredBeforeOneTimeRequest: {
      completedEmbeddedSignup: authorized === true,
      webhookReceiverReady: receiverReady === true,
      durableHistoryImporterReady: importerReady === true,
      within24Hours: ageMs < 24 * 60 * 60 * 1000,
      historySharingConsented: historyConsent === true,
    },
    // No tokens, network calls, automatic POSTs or database mutations.
  };
}
module.exports = { prepareCoexistenceSyncPlan };
