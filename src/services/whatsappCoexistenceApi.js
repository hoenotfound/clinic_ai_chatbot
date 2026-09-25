const {
  DEFAULT_GRAPH_API_VERSION,
  graphRequest,
} = require("../provisioning/whatsappWebhookSubscription");

const COEXISTENCE_SYNC_TYPES = new Set(["history", "smb_app_state_sync"]);

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function isCoexistenceReady(status) {
  return status?.is_on_biz_app === true && status?.platform_type === "CLOUD_API";
}

async function getCoexistenceStatus({
  phoneNumberId,
  accessToken,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
} = {}) {
  const id = required(phoneNumberId, "WhatsApp phone number ID");
  const token = required(accessToken, "WhatsApp access token");
  const payload = await graphRequest({
    path: `${encodeURIComponent(id)}?fields=is_on_biz_app,platform_type`,
    accessToken: token,
    graphVersion,
    fetchImpl,
  });

  return {
    phoneNumberId: payload?.id || id,
    isOnBusinessApp: payload?.is_on_biz_app === true,
    platformType: payload?.platform_type || null,
    ready: isCoexistenceReady(payload),
  };
}

/**
 * Meta allows each Business App data sync type only in the onboarding window.
 * Keep this low-level helper separate from provisioning so no normal client
 * setup can trigger a one-time history/contact import accidentally.
 */
async function requestBusinessAppDataSync({
  phoneNumberId,
  accessToken,
  syncType,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
} = {}) {
  const id = required(phoneNumberId, "WhatsApp phone number ID");
  const token = required(accessToken, "WhatsApp access token");
  const normalizedType = required(syncType, "Business App sync type");
  if (!COEXISTENCE_SYNC_TYPES.has(normalizedType)) {
    throw new Error(`Unsupported Business App sync type: ${normalizedType}.`);
  }

  return graphRequest({
    path: `${encodeURIComponent(id)}/smb_app_data`,
    method: "POST",
    accessToken: token,
    graphVersion,
    fetchImpl,
    body: {
      messaging_product: "whatsapp",
      sync_type: normalizedType,
    },
  });
}

module.exports = {
  COEXISTENCE_SYNC_TYPES,
  getCoexistenceStatus,
  isCoexistenceReady,
  requestBusinessAppDataSync,
};
