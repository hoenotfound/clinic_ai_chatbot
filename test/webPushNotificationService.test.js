const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  DEFAULT_TTL_SECONDS,
  buildPayload,
  canReceiveContactPush,
  deliverToSubscriptions,
  pushConfig,
} = require("../src/services/webPushNotificationService");
const { isAllowedPushEndpoint } = require("../src/db/pushSubscriptionsRepo");

test("high-priority push survives short offline and Doze windows", () => {
  assert.equal(DEFAULT_TTL_SECONDS, 3600);
});

test("push endpoints are restricted to trusted browser push services", () => {
  assert.equal(
    isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/example"),
    true
  );
  assert.equal(
    isAllowedPushEndpoint("https://android.googleapis.com/gcm/send/example"),
    true
  );
  assert.equal(
    isAllowedPushEndpoint("https://web.push.apple.com/Qexample"),
    true
  );
  assert.equal(
    isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example"),
    true
  );

  assert.equal(isAllowedPushEndpoint("https://example.com/push"), false);
  assert.equal(isAllowedPushEndpoint("https://127.0.0.1/push"), false);
  assert.equal(
    isAllowedPushEndpoint("https://fcm.googleapis.com.evil.example/push"),
    false
  );
  assert.equal(
    isAllowedPushEndpoint("https://fcm.googleapis.com:8443/push"),
    false
  );
});

test("push config requires a matching P-256 VAPID key pair", () => {
  const ecdh = crypto.createECDH("prime256v1");
  const publicKey = ecdh.generateKeys().toString("base64url");
  const privateKey = ecdh.getPrivateKey().toString("base64url");

  assert.equal(
    pushConfig({
      WEB_PUSH_VAPID_PUBLIC_KEY: publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: privateKey,
      PUBLIC_BASE_URL: "https://example.com",
    }).configured,
    true
  );

  const other = crypto.createECDH("prime256v1");
  other.generateKeys();
  assert.equal(
    pushConfig({
      WEB_PUSH_VAPID_PUBLIC_KEY: publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: other.getPrivateKey().toString("base64url"),
    }).configured,
    false
  );
  assert.equal(
    pushConfig({
      WEB_PUSH_VAPID_PUBLIC_KEY: publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: privateKey,
      WEB_PUSH_SUBJECT: "not-a-valid-contact-uri",
    }).configured,
    false
  );
  assert.equal(pushConfig({}).configured, false);
});

test("contact push access follows lead visibility instead of broadcasting customer identity", () => {
  const context = { owner_username: "sarah" };

  assert.equal(
    canReceiveContactPush(
      { username: "admin", role: "admin", permissions: {} },
      context
    ),
    true
  );
  assert.equal(
    canReceiveContactPush(
      {
        username: "sarah",
        role: "sales",
        permissions: { view_assigned_leads: true, view_all_leads: false },
      },
      context
    ),
    true
  );
  assert.equal(
    canReceiveContactPush(
      {
        username: "jane",
        role: "sales",
        permissions: { view_assigned_leads: true, view_all_leads: false },
      },
      context
    ),
    false
  );
});

test("push payload contains staff-action context but never customer message text", () => {
  const payload = buildPayload("booking_ready", {
    id: 42,
    name: "Mei Ling",
    latest_customer_message: "This must never appear on the lock screen",
  });

  assert.equal(payload.title, "Booking Ready");
  assert.match(payload.body, /Mei Ling/);
  assert.equal(payload.url, "/inbox?contact=42");
  assert.doesNotMatch(JSON.stringify(payload), /must never appear/);
});

test("delivery records success and terminal failures independently per device", async () => {
  const successes = [];
  const failures = [];
  const repository = {
    async markSuccess(id) {
      successes.push(id);
    },
    async markFailure(id, options) {
      failures.push([id, options]);
    },
  };
  const subscriptions = [
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ];
  const send = async (subscription) => {
    if (subscription.id === 1) return { status: "sent", statusCode: 201 };
    if (subscription.id === 2) {
      return { status: "failed", statusCode: 410, terminal: true };
    }
    throw new Error("temporary network error");
  };

  const result = await deliverToSubscriptions(
    subscriptions,
    { title: "Test", body: "Test" },
    { repository, send, logger: { warn() {} } }
  );

  assert.deepEqual(successes, [1]);
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 2);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures[0], [2, { terminal: true }]);
  assert.deepEqual(failures[1], [3, undefined]);
});
