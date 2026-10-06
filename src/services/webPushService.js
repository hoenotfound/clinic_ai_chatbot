const webpush = require("web-push");
const webPushSubscriptionsRepo = require("../db/webPushSubscriptionsRepo");
const contactsRepo = require("../db/contactsRepo");
const { canAccessContact } = require("../utils/accessControl");

const MAX_ENDPOINT_LENGTH = 4096;
const MAX_KEY_LENGTH = 1024;
const MAX_NOTIFICATION_BODY = 160;

function safeText(value, max = MAX_NOTIFICATION_BODY) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : "";
}

function webPushConfig(env = process.env) {
  const publicKey = safeText(env.WEB_PUSH_VAPID_PUBLIC_KEY, 512);
  const privateKey = safeText(env.WEB_PUSH_VAPID_PRIVATE_KEY, 512);
  const subject = safeText(env.WEB_PUSH_VAPID_SUBJECT, 512);

  if (!publicKey || !privateKey || !subject) {
    return {
      configured: false,
      publicKey: publicKey || null,
      reason:
        "WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_VAPID_SUBJECT are required.",
    };
  }

  if (!/^mailto:.+@.+|^https:\/\//i.test(subject)) {
    return {
      configured: false,
      publicKey,
      reason: "WEB_PUSH_VAPID_SUBJECT must be a mailto: address or HTTPS URL.",
    };
  }

  return {
    configured: true,
    publicKey,
    privateKey,
    subject,
  };
}

function allowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return (
    host === "fcm.googleapis.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host === "updates.push.services.mozilla.com" ||
    host === "push.services.mozilla.com" ||
    host.endsWith(".push.services.mozilla.com") ||
    host === "wns.notify.windows.com" ||
    host.endsWith(".notify.windows.com")
  );
}

function normalizeSubscription(input) {
  const subscription = input && typeof input === "object" ? input : {};
  const endpoint = safeText(subscription.endpoint, MAX_ENDPOINT_LENGTH);
  const p256dh = safeText(subscription.keys?.p256dh, MAX_KEY_LENGTH);
  const auth = safeText(subscription.keys?.auth, MAX_KEY_LENGTH);

  if (!endpoint || !p256dh || !auth || !allowedPushEndpoint(endpoint)) {
    return null;
  }

  return {
    endpoint,
    p256dh,
    auth,
  };
}

function contactDisplayName(contact) {
  return (
    safeText(contact?.name, 80) ||
    safeText(contact?.whatsapp_profile_name, 80) ||
    "Customer"
  );
}

function createWebPushService({
  pushClient = webpush,
  repository = webPushSubscriptionsRepo,
  contacts = contactsRepo,
  canAccess = canAccessContact,
  env = process.env,
  logger = console,
} = {}) {
  let configuredFingerprint = null;

  function configureClient() {
    const config = webPushConfig(env);
    if (!config.configured) return config;

    const fingerprint = [config.subject, config.publicKey, config.privateKey].join("|");
    if (configuredFingerprint !== fingerprint) {
      try {
        pushClient.setVapidDetails(
          config.subject,
          config.publicKey,
          config.privateKey
        );
        configuredFingerprint = fingerprint;
      } catch (err) {
        return {
          configured: false,
          publicKey: config.publicKey,
          reason: err?.message || "Invalid Web Push VAPID configuration.",
        };
      }
    }
    return config;
  }

  async function sendToSubscription(row, payload) {
    try {
      await pushClient.sendNotification(
        {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        JSON.stringify(payload),
        {
          TTL: 120,
          urgency: "high",
        }
      );
      await repository.markSuccess(row.id).catch(() => {});
      return true;
    } catch (err) {
      const statusCode = Number(err?.statusCode) || null;
      if (statusCode === 404 || statusCode === 410) {
        await repository.deleteSubscriptionById(row.id).catch(() => {});
      } else {
        await repository.markFailure(row.id).catch(() => {});
      }
      logger.warn(
        `Web Push delivery failed for subscription ${row.id}:`,
        err?.message || err
      );
      return false;
    }
  }

  async function sendToAccessibleStaff(contactId, payload) {
    const config = configureClient();
    if (!config.configured) return { configured: false, sent: 0 };

    const rows = await repository.listActiveWithUsers();
    let sent = 0;

    for (const row of rows) {
      let allowed = false;
      try {
        allowed = await canAccess(row, contactId);
      } catch (err) {
        logger.warn(
          `Web Push access check failed for user ${row.username} and contact ${contactId}:`,
          err?.message || err
        );
        continue;
      }
      if (!allowed) continue;
      if (await sendToSubscription(row, payload)) sent += 1;
    }

    return { configured: true, sent };
  }

  async function statusForUser(userId) {
    const config = configureClient();
    return {
      configured: config.configured,
      publicKey: config.configured ? config.publicKey : null,
      reason: config.configured ? null : config.reason,
      subscriptionCount: await repository.countForUser(userId),
    };
  }

  async function saveSubscription({ userId, subscription, userAgent }) {
    const config = configureClient();
    if (!config.configured) {
      const err = new Error(config.reason || "Web Push is not configured.");
      err.code = "WEB_PUSH_NOT_CONFIGURED";
      throw err;
    }

    const normalized = normalizeSubscription(subscription);
    if (!normalized) {
      const err = new Error("Invalid or unsupported Web Push subscription.");
      err.code = "INVALID_WEB_PUSH_SUBSCRIPTION";
      throw err;
    }

    await repository.upsertSubscription({
      userId,
      ...normalized,
      userAgent: safeText(userAgent, 500) || null,
    });
    return { enabled: true };
  }

  async function removeSubscription({ userId, endpoint }) {
    const cleanedEndpoint = safeText(endpoint, MAX_ENDPOINT_LENGTH);
    if (!cleanedEndpoint) return { enabled: false };
    await repository.deleteSubscription(cleanedEndpoint, userId);
    return { enabled: false };
  }

  async function sendTestToUser(userId, endpoint = null) {
    const config = configureClient();
    if (!config.configured) {
      return { configured: false, sent: 0, reason: config.reason };
    }

    const allRows = await repository.listForUser(userId);
    const cleanedEndpoint = safeText(endpoint, MAX_ENDPOINT_LENGTH);
    const rows = cleanedEndpoint
      ? allRows.filter((row) => row.endpoint === cleanedEndpoint)
      : allRows;
    let sent = 0;
    for (const row of rows) {
      if (
        await sendToSubscription(row, {
          title: "Notifications are working",
          body: "Booking Ready, Needs Human Attention and delivery failure alerts will appear here.",
          url: "/inbox",
          tag: "web-push-test",
        })
      ) {
        sent += 1;
      }
    }
    return { configured: true, sent };
  }

  async function notifyBookingReady({ contactId }) {
    const contact = await contacts.getContactById(contactId);
    if (!contact) return { configured: true, sent: 0 };

    return sendToAccessibleStaff(contactId, {
      title: "Booking Ready",
      body: `${contactDisplayName(contact)} is ready to book.`,
      url: `/inbox?contact=${encodeURIComponent(contactId)}`,
      tag: `booking-ready:${contactId}`,
    });
  }

  async function notifyHumanAttention({ contactId }) {
    const contact = await contacts.getContactById(contactId);
    if (!contact) return { configured: true, sent: 0 };

    return sendToAccessibleStaff(contactId, {
      title: "Needs Human Attention",
      body: `${contactDisplayName(contact)} needs a staff reply.`,
      url: `/inbox?contact=${encodeURIComponent(contactId)}`,
      tag: `human-attention:${contactId}`,
    });
  }

  async function notifyDeliveryFailure({ contactId }) {
    const contact = await contacts.getContactById(contactId);
    if (!contact) return { configured: true, sent: 0 };

    return sendToAccessibleStaff(contactId, {
      title: "Message Delivery Failed",
      body: `A WhatsApp message to ${contactDisplayName(contact)} failed to deliver.`,
      url: `/inbox?contact=${encodeURIComponent(contactId)}`,
      tag: `delivery-failure:${contactId}`,
    });
  }

  return {
    notifyBookingReady,
    notifyDeliveryFailure,
    notifyHumanAttention,
    removeSubscription,
    saveSubscription,
    sendTestToUser,
    statusForUser,
  };
}

const defaultService = createWebPushService();

module.exports = {
  allowedPushEndpoint,
  createWebPushService,
  normalizeSubscription,
  notifyBookingReady: defaultService.notifyBookingReady,
  notifyDeliveryFailure: defaultService.notifyDeliveryFailure,
  notifyHumanAttention: defaultService.notifyHumanAttention,
  removeSubscription: defaultService.removeSubscription,
  saveSubscription: defaultService.saveSubscription,
  sendTestToUser: defaultService.sendTestToUser,
  statusForUser: defaultService.statusForUser,
  webPushConfig,
};
