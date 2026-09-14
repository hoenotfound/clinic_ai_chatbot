const test = require("node:test");
const assert = require("node:assert/strict");

const {
  configureWhatsAppWebhook,
  whatsappCallbackUrl,
} = require("../src/provisioning/whatsappWebhookSubscription");

test("builds client WhatsApp callback URL", () => {
  assert.equal(
    whatsappCallbackUrl("https://client-a.example.test/"),
    "https://client-a.example.test/webhook",
  );
});

test("configures and confirms a WABA callback override", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
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
            id: "app-id",
            override_callback_uri: "https://client-a.example.test/webhook",
          },
        ],
      }),
    };
  };

  const result = await configureWhatsAppWebhook({
    wabaId: "waba-123",
    accessToken: "access-token",
    verifyToken: "verify-token",
    clientBaseUrl: "https://client-a.example.test",
    fetchImpl,
  });

  assert.deepEqual(result, {
    wabaId: "waba-123",
    callbackUrl: "https://client-a.example.test/webhook",
    confirmed: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://graph.facebook.com/v26.0/waba-123/subscribed_apps");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    override_callback_uri: "https://client-a.example.test/webhook",
    verify_token: "verify-token",
  });
  assert.equal(calls[1].options.method, "GET");
});

test("fails when Meta does not confirm the callback override", async () => {
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    json: async () => options.method === "POST"
      ? { success: true }
      : { data: [{ id: "app-id" }] },
  });

  await assert.rejects(
    configureWhatsAppWebhook({
      wabaId: "waba-123",
      accessToken: "access-token",
      verifyToken: "verify-token",
      clientBaseUrl: "https://client-a.example.test",
      fetchImpl,
    }),
    (err) => err.code === "WHATSAPP_WEBHOOK_OVERRIDE_NOT_CONFIRMED",
  );
});
