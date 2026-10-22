"use strict";

// Read-only Meta Graph verification. This deliberately does not register
// phones, grant access, subscribe apps, or change callback overrides.
const {
  graphRequest,
  getWabaSubscriptions,
  subscriptionAppId,
  subscriptionMatchesCallback,
  whatsappCallbackUrl,
} = require("./whatsappWebhookSubscription");

function requireNumeric(value, label) {
  const id = String(value || "").trim();
  if (!/^\d+$/.test(id)) throw new Error(`${label} must be a numeric Meta ID.`);
  return id;
}

async function listAccountPhoneIds({
  wabaId,
  accessToken,
  graphVersion,
  fetchImpl = global.fetch,
  maxPages = 5,
}) {
  const id = requireNumeric(wabaId, "WhatsApp account ID");
  let cursor = null;
  const found = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    const path = `${encodeURIComponent(id)}/phone_numbers?fields=id,display_phone_number&limit=100`
      + (cursor ? `&after=${encodeURIComponent(cursor)}` : "");
    const payload = await graphRequest({ path, accessToken, graphVersion, fetchImpl });
    for (const phone of payload?.data || []) {
      if (phone?.id) found.add(String(phone.id));
    }
    cursor = payload?.paging?.cursors?.after || null;
    if (!payload?.paging?.next || !cursor) {
      return { phoneIds: [...found], complete: true };
    }
  }
  return { phoneIds: [...found], complete: false };
}

async function verifyWhatsAppSenderMapping({
  wabaId,
  phoneNumberId,
  appId,
  clientBaseUrl,
  accessToken,
  graphVersion,
  fetchImpl = global.fetch,
}) {
  const accountId = requireNumeric(wabaId, "WhatsApp account ID");
  const phoneId = requireNumeric(phoneNumberId, "WhatsApp phone ID");
  const sharedAppId = requireNumeric(appId, "Shared developer app ID");
  if (!accessToken || !String(accessToken).trim()) {
    throw new Error("WhatsApp management token is required (not accepted as a CLI flag).");
  }
  const callbackUrl = whatsappCallbackUrl(clientBaseUrl);
  const [phones, subscriptions] = await Promise.all([
    listAccountPhoneIds({ wabaId: accountId, accessToken, graphVersion, fetchImpl }),
    getWabaSubscriptions({ wabaId: accountId, accessToken, graphVersion, fetchImpl }),
  ]);
  const owned = phones.complete && phones.phoneIds.includes(phoneId);
  const matchingSubscription = subscriptions.find(row =>
    subscriptionAppId(row) === sharedAppId && subscriptionMatchesCallback(
      row, callbackUrl, sharedAppId
    )
  ) || null;
  return {
    accountId, phoneNumberId: phoneId, appId: sharedAppId, callbackUrl,
    accountPhoneInventoryComplete: phones.complete,
    phoneBelongsToAccount: owned,
    subscriptionToSharedAppConfirmed: Boolean(matchingSubscription),
    callbackOverrideMatches: Boolean(matchingSubscription),
    verified: owned && Boolean(matchingSubscription),
    // Never include access tokens or raw Graph API responses in the report.
  };
}

module.exports = { listAccountPhoneIds, verifyWhatsAppSenderMapping };
