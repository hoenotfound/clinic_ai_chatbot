const test = require("node:test");
const assert = require("node:assert/strict");

const {
  configureWhatsAppWebhook,
  getWhatsAppCoexistenceStatus,
  subscriptionMatchesCallback,
  whatsappCallbackUrl,
} = require("../src/provisioning/whatsappWebhookSubscription");

test("builds client WhatsApp callback URL", () => {
  assert.equal(
    whatsappCallbackUrl("https://client-a.example.test/"),
    "https://client-a.example.test/webhook",
  );
});

test("configures and confirms this Meta app's WABA callback override", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("https://client-a.example.test/webhook?")) {
      const parsed = new URL(url);
      return {
        ok: true,
        status: 200,
        text: async () => parsed.searchParams.get("hub.challenge"),
      };
    }
    if (options.method === "POST") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            override_callback_uri: "https://other-client.example.test/webhook",
            whatsapp_business_api_data: { id: "other-app-id", name: "Other App" },
          },
          {
            override_callback_uri: "https://client-a.example.test/webhook",
            whatsapp_business_api_data: { id: "app-id", name: "DA Chatbot" },
          },
        ],
      }),
    };
  };

  const result = await configureWhatsAppWebhook({
    wabaId: "waba-123",
    appId: "app-id",
    accessToken: "access-token",
    verifyToken: "verify-token",
    clientBaseUrl: "https://client-a.example.test",
    fetchImpl,
  });

  assert.deepEqual(result, {
    wabaId: "waba-123",
    appId: "app-id",
    callbackUrl: "https://client-a.example.test/webhook",
    confirmed: true,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /^https:\/\/client-a\.example\.test\/webhook\?/);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "https://graph.facebook.com/v26.0/waba-123/subscribed_apps");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    override_callback_uri: "https://client-a.example.test/webhook",
    verify_token: "verify-token",
  });
  assert.equal(calls[2].url, "https://graph.facebook.com/v26.0/waba-123/subscribed_apps?limit=100");
  assert.equal(calls[2].options.method, "GET");
});

test("requires the matching Meta app when app id is supplied", () => {
  const subscription = {
    override_callback_uri: "https://client-a.example.test/webhook",
    whatsapp_business_api_data: { id: "app-a" },
  };
  assert.equal(
    subscriptionMatchesCallback(subscription, "https://client-a.example.test/webhook", "app-a"),
    true,
  );
  assert.equal(
    subscriptionMatchesCallback(subscription, "https://client-a.example.test/webhook", "app-b"),
    false,
  );
});

test("fails before changing Meta when the client callback verification token is wrong", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    };
  };

  await assert.rejects(
    configureWhatsAppWebhook({
      wabaId: "waba-123",
      accessToken: "access-token",
      verifyToken: "wrong-token",
      clientBaseUrl: "https://client-a.example.test",
      fetchImpl,
    }),
    (err) => err.code === "WHATSAPP_WEBHOOK_ENDPOINT_VERIFY_FAILED",
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/client-a\.example\.test\/webhook\?/);
});

test("fails when Meta does not confirm the callback override for the expected app", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.startsWith("https://client-a.example.test/webhook?")) {
      const parsed = new URL(url);
      return {
        ok: true,
        status: 200,
        text: async () => parsed.searchParams.get("hub.challenge"),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => options.method === "POST"
        ? { success: true }
        : {
            data: [{
              override_callback_uri: "https://client-a.example.test/webhook",
              whatsapp_business_api_data: { id: "different-app-id" },
            }],
          },
    };
  };

  await assert.rejects(
    configureWhatsAppWebhook({
      wabaId: "waba-123",
      appId: "app-id",
      accessToken: "access-token",
      verifyToken: "verify-token",
      clientBaseUrl: "https://client-a.example.test",
      fetchImpl,
    }),
    (err) => err.code === "WHATSAPP_WEBHOOK_OVERRIDE_NOT_CONFIRMED",
  );
});


test("coexistence configuration subscribes the required message-path fields", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("https://client-a.example.test/webhook?")) {
      const parsed = new URL(url);
      return {
        ok: true,
        status: 200,
        text: async () => parsed.searchParams.get("hub.challenge"),
      };
    }
    if (options.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{
          override_callback_uri: "https://client-a.example.test/webhook",
          whatsapp_business_api_data: { id: "app-id", name: "DA Chatbot" },
        }],
      }),
    };
  };

  const result = await configureWhatsAppWebhook({
    wabaId: "waba-123",
    appId: "app-id",
    accessToken: "access-token",
    verifyToken: "verify-token",
    clientBaseUrl: "https://client-a.example.test",
    coexistence: true,
    fetchImpl,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[1].options.method, "POST");
  const baselineBody = JSON.parse(calls[1].options.body);
  assert.deepEqual(baselineBody.subscribed_fields, [
    "messages",
    "smb_message_echoes",
    "smb_app_state_sync",
    "history",
  ]);

  assert.equal(calls[2].options.method, "POST");
  const overrideBody = JSON.parse(calls[2].options.body);
  assert.equal(
    overrideBody.override_callback_uri,
    "https://client-a.example.test/webhook"
  );
  assert.equal(overrideBody.verify_token, "verify-token");
  assert.deepEqual(overrideBody.subscribed_fields, baselineBody.subscribed_fields);
  assert.equal(
    calls[3].url,
    "https://graph.facebook.com/v26.0/waba-123/subscribed_apps?limit=100"
  );
  assert.equal(result.coexistence, true);
});


test("coexistence status requires both Business App presence and Cloud API platform", async () => {
  const fetchImpl = async (url, options = {}) => {
    assert.equal(
      url,
      "https://graph.facebook.com/v26.0/phone-123?fields=is_on_biz_app,platform_type"
    );
    assert.equal(options.headers.Authorization, "Bearer access-token");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: "phone-123",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
      }),
    };
  };

  assert.deepEqual(
    await getWhatsAppCoexistenceStatus({
      phoneNumberId: "phone-123",
      accessToken: "access-token",
      fetchImpl,
    }),
    {
      phoneNumberId: "phone-123",
      isOnBizApp: true,
      platformType: "CLOUD_API",
      coexistenceReady: true,
    }
  );
});

test("coexistence status does not treat Business App-only platform state as ready", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: "phone-123",
      is_on_biz_app: true,
      platform_type: "ON_PREMISE",
    }),
  });

  const result = await getWhatsAppCoexistenceStatus({
    phoneNumberId: "phone-123",
    accessToken: "access-token",
    fetchImpl,
  });
  assert.equal(result.coexistenceReady, false);
  assert.equal(result.isOnBizApp, true);
  assert.equal(result.platformType, "ON_PREMISE");
});
