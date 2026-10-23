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

async function checkCoexistencePhone({
  phoneNumberId,accessToken,graphVersion,fetchImpl=global.fetch,
}) {
  const phoneId=requireNumeric(phoneNumberId,"WhatsApp phone ID");
  const data=await graphRequest({
    path:encodeURIComponent(phoneId)+"?fields=is_on_biz_app,platform_type",
    accessToken,graphVersion,fetchImpl,
  });
  return {phoneNumberId:phoneId,
    isOnBusinessApp:data?.is_on_biz_app===true,
    platformType:typeof data?.platform_type==="string"?data.platform_type:null,
    verified:data?.id===phoneId && data?.is_on_biz_app===true &&
      data?.platform_type==="CLOUD_API"};
}

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
    const more = Boolean(payload?.paging?.next);
    cursor = payload?.paging?.cursors?.after || null;
    if (!more) return { phoneIds: [...found], complete: true };
    if (!cursor) return { phoneIds: [...found], complete: false };
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
  requireCoexistence = false,
}) {
  const accountId = requireNumeric(wabaId, "WhatsApp account ID");
  const phoneId = requireNumeric(phoneNumberId, "WhatsApp phone ID");
  const sharedAppId = requireNumeric(appId, "Shared developer app ID");
  if (!accessToken || !String(accessToken).trim()) {
    throw new Error("WhatsApp management token is required (not accepted as a CLI flag).");
  }
  const callbackUrl = whatsappCallbackUrl(clientBaseUrl);
  const [phones, subscriptions, coexistence] = await Promise.all([
    listAccountPhoneIds({ wabaId: accountId, accessToken, graphVersion, fetchImpl }),
    getWabaSubscriptions({ wabaId: accountId, accessToken, graphVersion, fetchImpl }),
    requireCoexistence
      ? checkCoexistencePhone({phoneNumberId:phoneId,accessToken,graphVersion,fetchImpl})
      : Promise.resolve(null),
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
    coexistence:requireCoexistence?coexistence:null,
    verified: owned && Boolean(matchingSubscription) &&
      (!requireCoexistence || coexistence?.verified===true),
    // Never include access tokens or raw Graph API responses in the report.
  };
}

module.exports = { listAccountPhoneIds, verifyWhatsAppSenderMapping, checkCoexistencePhone };
