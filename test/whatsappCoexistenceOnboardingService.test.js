const test = require("node:test");
const assert = require("node:assert/strict");

const {
  WhatsAppCoexistenceOnboardingError,
  choosePhoneNumber,
  completeEmbeddedSignup,
  publicConfig,
  validateFinishSession,
} = require("../src/services/whatsappCoexistenceOnboardingService");

function env(overrides = {}) {
  return {
    META_APP_ID: "app-123",
    META_APP_SECRET: "app-secret",
    META_EMBEDDED_SIGNUP_CONFIG_ID: "config-456",
    META_GRAPH_API_VERSION: "v26.0",
    WHATSAPP_VERIFY_TOKEN: "verify-token",
    WHATSAPP_COEXISTENCE_ENABLED: "false",
    WHATSAPP_WABA_ID: "test-waba",
    WHATSAPP_PHONE_NUMBER_ID: "test-phone",
    ...overrides,
  };
}

function finish(data = {}) {
  return {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    version: 3,
    data: {
      waba_id: "waba-live",
      ...data,
    },
  };
}

test("public onboarding config exposes identifiers but never Meta secrets or WhatsApp tokens", () => {
  const source = env({
    WHATSAPP_TOKEN: "runtime-secret-token",
  });
  const config = publicConfig(source);

  assert.equal(config.configured, true);
  assert.equal(config.appId, "app-123");
  assert.equal(config.configId, "config-456");
  assert.equal(config.featureType, "whatsapp_business_app_onboarding");
  assert.equal(config.sessionInfoVersion, "3");
  assert.equal(config.runtime.coexistenceEnabled, false);
  assert.equal(config.runtime.wabaId, "test-waba");
  assert.equal(config.runtime.phoneNumberId, "test-phone");
  assert.equal(Object.prototype.hasOwnProperty.call(config, "appSecret"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(config, "accessToken"), false);
  assert.equal(JSON.stringify(config).includes("app-secret"), false);
  assert.equal(JSON.stringify(config).includes("runtime-secret-token"), false);
});

test("finish session must be the Business App coexistence completion event", () => {
  assert.deepEqual(validateFinishSession(finish({ phone_number_id: "phone-live" })), {
    wabaId: "waba-live",
    phoneNumberId: "phone-live",
    eventVersion: 3,
  });

  assert.throws(
    () => validateFinishSession({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      version: 3,
      data: { waba_id: "waba-live" },
    }),
    (err) => err.code === "WHATSAPP_COEXISTENCE_FINISH_EVENT_REQUIRED"
  );
});

test("phone returned by Meta must belong to the authorized WABA", () => {
  assert.throws(
    () => choosePhoneNumber(
      [{ id: "phone-a", isOnBizApp: true, coexistenceReady: true }],
      "phone-b"
    ),
    (err) => err.code === "WHATSAPP_COEXISTENCE_PHONE_WABA_MISMATCH"
  );
});

test("ambiguous WABA never guesses a production phone number", () => {
  assert.throws(
    () => choosePhoneNumber([
      { id: "phone-a", isOnBizApp: true, coexistenceReady: true },
      { id: "phone-b", isOnBizApp: true, coexistenceReady: true },
    ]),
    (err) =>
      err instanceof WhatsAppCoexistenceOnboardingError &&
      err.code === "WHATSAPP_COEXISTENCE_PHONE_AMBIGUOUS"
  );
});

test("Embedded Signup validates WABA and phone without registering, subscribing, or changing runtime", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method || "GET",
      body: options.body || null,
      authorization: options.headers?.Authorization || null,
    });

    if (String(url).endsWith("/oauth/access_token")) {
      assert.equal(options.method, "POST");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("client_id"), "app-123");
      assert.equal(form.get("client_secret"), "app-secret");
      assert.equal(form.get("code"), "short-code");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: "bisu-secret-token",
          token_type: "bearer",
          expires_in: 3600,
        }),
      };
    }

    if (String(url).includes("/debug_token?")) {
      assert.equal(options.headers.Authorization, "Bearer app-123|app-secret");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            app_id: "app-123",
            is_valid: true,
            expires_at: 1800000000,
            scopes: [
              "whatsapp_business_management",
              "whatsapp_business_messaging",
            ],
          },
        }),
      };
    }

    if (String(url).includes("/waba-live?fields=id,name")) {
      assert.equal(options.headers.Authorization, "Bearer bisu-secret-token");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "waba-live", name: "Neutro Sense WABA" }),
      };
    }

    if (String(url).includes("/waba-live/phone_numbers?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            id: "phone-live",
            display_phone_number: "+60 12-297 2817",
            verified_name: "Ariel Lee",
          }],
        }),
      };
    }

    if (String(url).includes("/phone-live?fields=is_on_biz_app,platform_type")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: "phone-live",
          is_on_biz_app: true,
          platform_type: "CLOUD_API",
        }),
      };
    }

    throw new Error("Unexpected URL: " + url);
  };

  const result = await completeEmbeddedSignup({
    code: "short-code",
    sessionInfo: finish({ phone_number_id: "phone-live" }),
    env: env(),
    fetchImpl,
  });

  assert.equal(result.waba.id, "waba-live");
  assert.equal(result.phone.id, "phone-live");
  assert.equal(result.phone.coexistenceReady, true);
  assert.equal(result.runtime.wabaId, "test-waba");
  assert.equal(result.runtime.phoneNumberId, "test-phone");
  assert.equal(result.runtime.coexistenceEnabled, false);
  assert.equal(result.runtime.wabaMatches, false);
  assert.equal(result.runtime.phoneMatches, false);
  assert.equal(result.activationRequired, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "accessToken"), false);
  assert.equal(JSON.stringify(result).includes("bisu-secret-token"), false);

  assert.equal(
    calls.some((call) => /\/register(?:\?|$)/.test(call.url)),
    false,
    "coexistence onboarding must skip normal phone registration"
  );
  assert.equal(
    calls.some((call) => call.url.includes("/subscribed_apps")),
    false,
    "authorization must not subscribe or move the production WABA webhook"
  );
});

test("status propagation failure does not discard a successfully authorized single phone", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/oauth/access_token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "token" }),
      };
    }
    if (String(url).includes("/debug_token?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            app_id: "app-123",
            is_valid: true,
            scopes: ["whatsapp_business_management"],
          },
        }),
      };
    }
    if (String(url).includes("/waba-live?fields=id,name")) {
      return { ok: true, status: 200, json: async () => ({ id: "waba-live" }) };
    }
    if (String(url).includes("/waba-live/phone_numbers?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "phone-live", display_phone_number: "+60122972817" }],
        }),
      };
    }
    if (String(url).includes("/phone-live?fields=is_on_biz_app,platform_type")) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "Propagation delay" } }),
      };
    }
    throw new Error("Unexpected URL: " + url + " " + (options.method || "GET"));
  };

  const result = await completeEmbeddedSignup({
    code: "short-code",
    sessionInfo: finish(),
    env: env(),
    fetchImpl,
  });

  assert.equal(result.phone.id, "phone-live");
  assert.equal(result.phone.coexistenceReady, false);
  assert.equal(result.activationRequired, true);
});
