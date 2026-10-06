const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWebPushService,
  normalizeSubscription,
} = require("../src/services/webPushService");

const env = {
  WEB_PUSH_VAPID_PUBLIC_KEY: "test-public-key",
  WEB_PUSH_VAPID_PRIVATE_KEY: "test-private-key",
  WEB_PUSH_VAPID_SUBJECT: "mailto:test@example.com",
};

function subscriptionRow(overrides = {}) {
  return {
    id: 1,
    user_id: 10,
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    p256dh: "p256dh",
    auth: "auth",
    username: "staff",
    role: "staff",
    permissions: { view_all_leads: true },
    is_active: true,
    ...overrides,
  };
}

test("Web Push accepts known browser push services and rejects arbitrary HTTPS endpoints", () => {
  assert.deepEqual(
    normalizeSubscription({
      endpoint: "https://web.push.apple.com/Q123",
      keys: { p256dh: "key", auth: "secret" },
    }),
    {
      endpoint: "https://web.push.apple.com/Q123",
      p256dh: "key",
      auth: "secret",
    }
  );

  assert.equal(
    normalizeSubscription({
      endpoint: "https://internal.example.com/push",
      keys: { p256dh: "key", auth: "secret" },
    }),
    null
  );
});

test("Booking Ready push is sent only to staff who can access that contact", async () => {
  const sent = [];
  const successful = [];
  const rows = [
    subscriptionRow(),
    subscriptionRow({
      id: 2,
      endpoint: "https://fcm.googleapis.com/fcm/send/blocked",
      username: "blocked",
    }),
  ];
  const service = createWebPushService({
    env,
    pushClient: {
      setVapidDetails() {},
      async sendNotification(subscription, payload, options) {
        sent.push({ subscription, payload: JSON.parse(payload), options });
      },
    },
    repository: {
      async listActiveWithUsers() { return rows; },
      async markSuccess(id) { successful.push(id); },
      async markFailure() {},
      async deleteSubscriptionById() {},
    },
    contacts: {
      async getContactById() {
        return { id: 42, name: "Mei Ling" };
      },
    },
    async canAccess(user) {
      return user.username !== "blocked";
    },
  });

  const result = await service.notifyBookingReady({ contactId: 42 });

  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(successful, [1]);
  assert.equal(sent[0].payload.title, "Booking Ready");
  assert.equal(sent[0].payload.body, "Mei Ling is ready to book.");
  assert.equal(sent[0].payload.url, "/inbox?contact=42");
  assert.equal(sent[0].options.urgency, "high");
});

test("expired push subscriptions are removed after a 410 response", async () => {
  const removed = [];
  const service = createWebPushService({
    env,
    logger: { warn() {} },
    pushClient: {
      setVapidDetails() {},
      async sendNotification() {
        const err = new Error("gone");
        err.statusCode = 410;
        throw err;
      },
    },
    repository: {
      async listActiveWithUsers() { return [subscriptionRow()]; },
      async markSuccess() {},
      async markFailure() {},
      async deleteSubscriptionById(id) { removed.push(id); },
    },
    contacts: {
      async getContactById() {
        return { id: 42, whatsapp_profile_name: "Customer" };
      },
    },
    async canAccess() { return true; },
  });

  const result = await service.notifyHumanAttention({ contactId: 42 });
  assert.equal(result.sent, 0);
  assert.deepEqual(removed, [1]);
});

test("Web Push service has no generic new-customer-message notification trigger", () => {
  const service = createWebPushService({
    env,
    pushClient: { setVapidDetails() {} },
    repository: {},
    contacts: {},
    canAccess: async () => true,
  });

  assert.equal(service.notifyNewCustomerMessage, undefined);
});
