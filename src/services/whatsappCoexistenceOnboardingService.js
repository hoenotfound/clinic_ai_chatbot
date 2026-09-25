const {
  DEFAULT_GRAPH_API_VERSION,
  fetchWithTimeout,
  getWhatsAppCoexistenceStatus,
  graphRequest,
  normalizedGraphVersion,
} = require("../provisioning/whatsappWebhookSubscription");

const FINISH_EVENT = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
const EMBEDDED_SIGNUP_TYPE = "WA_EMBEDDED_SIGNUP";
const DEFAULT_TIMEOUT_MS = 10000;

class WhatsAppCoexistenceOnboardingError extends Error {
  constructor(message, {
    code = "WHATSAPP_COEXISTENCE_ONBOARDING_FAILED",
    status = 400,
    retrySafe = true,
    details = null,
    cause = null,
  } = {}) {
    super(message);
    this.name = "WhatsAppCoexistenceOnboardingError";
    this.code = code;
    this.status = status;
    this.retrySafe = retrySafe;
    this.details = details;
    this.cause = cause || null;
  }
}

function clean(value) {
  return String(value || "").trim();
}

function appId(env = process.env) {
  return clean(env.META_APP_ID || env.WHATSAPP_APP_ID);
}

function appSecret(env = process.env) {
  return clean(env.META_APP_SECRET || env.WHATSAPP_APP_SECRET);
}

function configId(env = process.env) {
  return clean(env.META_EMBEDDED_SIGNUP_CONFIG_ID);
}

function graphVersion(env = process.env) {
  return normalizedGraphVersion(
    env.META_GRAPH_API_VERSION ||
    env.META_MARKETING_API_VERSION ||
    DEFAULT_GRAPH_API_VERSION
  );
}

function publicConfig(env = process.env) {
  const values = {
    appId: appId(env),
    configId: configId(env),
    graphVersion: graphVersion(env),
  };
  const missing = [];
  if (!values.appId) missing.push("META_APP_ID");
  if (!values.configId) missing.push("META_EMBEDDED_SIGNUP_CONFIG_ID");
  if (!appSecret(env)) missing.push("META_APP_SECRET");
  if (!clean(env.WHATSAPP_VERIFY_TOKEN)) missing.push("WHATSAPP_VERIFY_TOKEN");

  return {
    configured: missing.length === 0,
    missing,
    ...values,
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
    runtime: {
      coexistenceEnabled:
        clean(env.WHATSAPP_COEXISTENCE_ENABLED).toLowerCase() === "true",
      wabaId: clean(env.WHATSAPP_WABA_ID) || null,
      phoneNumberId: clean(env.WHATSAPP_PHONE_NUMBER_ID) || null,
    },
  };
}

function safeSessionInfo(sessionInfo) {
  const payload = sessionInfo && typeof sessionInfo === "object" ? sessionInfo : {};
  return {
    type: clean(payload.type),
    event: clean(payload.event),
    version: Number.isInteger(Number(payload.version)) ? Number(payload.version) : null,
    data: payload.data && typeof payload.data === "object" ? payload.data : {},
  };
}

function validateFinishSession(sessionInfo) {
  const session = safeSessionInfo(sessionInfo);
  if (session.type !== EMBEDDED_SIGNUP_TYPE || session.event !== FINISH_EVENT) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta did not return a completed WhatsApp Business App onboarding session.",
      { code: "WHATSAPP_COEXISTENCE_FINISH_EVENT_REQUIRED" }
    );
  }

  const wabaId = clean(session.data.waba_id);
  if (!wabaId) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta completed the signup flow without a WhatsApp Business Account ID.",
      { code: "WHATSAPP_COEXISTENCE_WABA_ID_MISSING" }
    );
  }

  return {
    wabaId,
    phoneNumberId: clean(session.data.phone_number_id) || null,
    eventVersion: session.version,
  };
}

async function exchangeCodeForToken({
  code,
  env = process.env,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const authorizationCode = clean(code);
  const clientId = appId(env);
  const clientSecret = appSecret(env);
  const version = graphVersion(env);

  if (!authorizationCode) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The Embedded Signup authorization code is missing.",
      { code: "WHATSAPP_COEXISTENCE_CODE_MISSING" }
    );
  }
  if (!clientId || !clientSecret) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta Embedded Signup server credentials are not configured.",
      {
        code: "WHATSAPP_COEXISTENCE_META_APP_CONFIG_MISSING",
        status: 503,
        retrySafe: true,
      }
    );
  }

  const url = `https://graph.facebook.com/${version}/oauth/access_token`;
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: authorizationCode,
  });
  const redirectUri = clean(env.META_EMBEDDED_SIGNUP_REDIRECT_URI);
  if (redirectUri) form.set("redirect_uri", redirectUri);

  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
      {
        fetchImpl,
        timeoutMs,
        timeoutMessage: "Meta authorization-code exchange timed out.",
        timeoutCode: "WHATSAPP_COEXISTENCE_CODE_EXCHANGE_TIMEOUT",
      }
    );
  } catch (err) {
    throw new WhatsAppCoexistenceOnboardingError(
      err?.message || "Meta authorization-code exchange failed.",
      {
        code: err?.code || "WHATSAPP_COEXISTENCE_CODE_EXCHANGE_FAILED",
        status: 502,
        retrySafe: true,
        cause: err,
      }
    );
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error || !clean(payload?.access_token)) {
    const providerMessage = clean(
      payload?.error?.error_user_msg ||
      payload?.error?.message ||
      payload?.message
    );
    throw new WhatsAppCoexistenceOnboardingError(
      providerMessage || "Meta rejected the Embedded Signup authorization code.",
      {
        code: "WHATSAPP_COEXISTENCE_CODE_EXCHANGE_REJECTED",
        status: response.status >= 500 ? 502 : 400,
        retrySafe: response.status >= 500 || response.status === 429,
      }
    );
  }

  return {
    accessToken: clean(payload.access_token),
    tokenType: clean(payload.token_type) || null,
    expiresIn: Number.isFinite(Number(payload.expires_in))
      ? Number(payload.expires_in)
      : null,
  };
}

async function inspectToken({
  accessToken,
  env = process.env,
  fetchImpl = global.fetch,
}) {
  const clientId = appId(env);
  const clientSecret = appSecret(env);
  const payload = await graphRequest({
    path: `debug_token?input_token=${encodeURIComponent(accessToken)}`,
    accessToken: `${clientId}|${clientSecret}`,
    graphVersion: graphVersion(env),
    fetchImpl,
  });
  const data = payload?.data || {};
  if (data.is_valid !== true || clean(data.app_id) !== clientId) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta returned an invalid or mismatched Embedded Signup access token.",
      { code: "WHATSAPP_COEXISTENCE_TOKEN_INVALID", status: 502 }
    );
  }

  return {
    appId: clean(data.app_id),
    userId: clean(data.user_id) || null,
    expiresAt:
      Number.isFinite(Number(data.expires_at)) && Number(data.expires_at) > 0
        ? new Date(Number(data.expires_at) * 1000).toISOString()
        : null,
    scopes: Array.isArray(data.scopes) ? data.scopes.map(clean).filter(Boolean) : [],
    granularScopes: Array.isArray(data.granular_scopes) ? data.granular_scopes : [],
  };
}

async function fetchWaba({
  wabaId,
  accessToken,
  env = process.env,
  fetchImpl = global.fetch,
}) {
  const payload = await graphRequest({
    path: `${encodeURIComponent(wabaId)}?fields=id,name`,
    accessToken,
    graphVersion: graphVersion(env),
    fetchImpl,
  });
  if (clean(payload?.id) !== clean(wabaId)) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The authorized WhatsApp Business Account could not be verified.",
      { code: "WHATSAPP_COEXISTENCE_WABA_VERIFY_FAILED", status: 502 }
    );
  }
  return {
    id: clean(payload.id),
    name: clean(payload.name) || null,
  };
}

async function fetchPhoneNumbers({
  wabaId,
  accessToken,
  env = process.env,
  fetchImpl = global.fetch,
}) {
  const payload = await graphRequest({
    path:
      `${encodeURIComponent(wabaId)}/phone_numbers` +
      "?fields=id,display_phone_number,verified_name&limit=100",
    accessToken,
    graphVersion: graphVersion(env),
    fetchImpl,
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return Promise.all(
    rows.map(async (phone) => {
      let status = {
        phoneNumberId: clean(phone?.id),
        isOnBizApp: false,
        platformType: null,
        coexistenceReady: false,
      };
      try {
        status = await getWhatsAppCoexistenceStatus({
          phoneNumberId: phone?.id,
          accessToken,
          graphVersion: graphVersion(env),
          fetchImpl,
        });
      } catch (_) {
        // The completion event is authoritative for onboarding completion.
        // Status propagation can lag, so expose an unconfirmed state instead
        // of converting a successful authorization into a false failure.
      }
      return {
        id: clean(phone?.id),
        displayPhoneNumber: clean(phone?.display_phone_number) || null,
        verifiedName: clean(phone?.verified_name) || null,
        isOnBizApp: status.isOnBizApp === true,
        platformType: status.platformType || null,
        coexistenceReady: status.coexistenceReady === true,
      };
    })
  );
}

function choosePhoneNumber(phones, requestedPhoneNumberId = null) {
  const requested = clean(requestedPhoneNumberId);
  if (requested) {
    const matched = phones.find((phone) => phone.id === requested);
    if (!matched) {
      throw new WhatsAppCoexistenceOnboardingError(
        "The phone number returned by Meta does not belong to the authorized WhatsApp Business Account.",
        { code: "WHATSAPP_COEXISTENCE_PHONE_WABA_MISMATCH" }
      );
    }
    return matched;
  }

  if (phones.length === 1) return phones[0];

  const coexistencePhones = phones.filter(
    (phone) => phone.isOnBizApp || phone.coexistenceReady
  );
  if (coexistencePhones.length === 1) return coexistencePhones[0];

  throw new WhatsAppCoexistenceOnboardingError(
    "Meta authorized the WhatsApp Business Account but did not identify one unambiguous Business App phone number.",
    {
      code: "WHATSAPP_COEXISTENCE_PHONE_AMBIGUOUS",
      details: {
        phoneNumbers: phones.map((phone) => ({
          id: phone.id,
          displayPhoneNumber: phone.displayPhoneNumber,
          verifiedName: phone.verifiedName,
          isOnBizApp: phone.isOnBizApp,
          platformType: phone.platformType,
        })),
      },
    }
  );
}

async function completeEmbeddedSignup({
  code,
  sessionInfo,
  env = process.env,
  fetchImpl = global.fetch,
}) {
  const finish = validateFinishSession(sessionInfo);
  const exchanged = await exchangeCodeForToken({ code, env, fetchImpl });
  const token = await inspectToken({
    accessToken: exchanged.accessToken,
    env,
    fetchImpl,
  });

  if (!token.scopes.includes("whatsapp_business_management")) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The Meta authorization did not grant whatsapp_business_management.",
      { code: "WHATSAPP_COEXISTENCE_MANAGEMENT_SCOPE_MISSING" }
    );
  }

  const waba = await fetchWaba({
    wabaId: finish.wabaId,
    accessToken: exchanged.accessToken,
    env,
    fetchImpl,
  });
  const phones = await fetchPhoneNumbers({
    wabaId: finish.wabaId,
    accessToken: exchanged.accessToken,
    env,
    fetchImpl,
  });
  if (!phones.length) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The authorized WhatsApp Business Account does not expose any phone numbers.",
      { code: "WHATSAPP_COEXISTENCE_PHONE_NOT_FOUND" }
    );
  }

  const phone = choosePhoneNumber(phones, finish.phoneNumberId);
  const runtime = publicConfig(env).runtime;

  return {
    event: FINISH_EVENT,
    eventVersion: finish.eventVersion,
    waba,
    phone,
    permissions: {
      whatsappBusinessManagement: true,
      whatsappBusinessMessaging: token.scopes.includes("whatsapp_business_messaging"),
    },
    tokenExpiresAt: token.expiresAt,
    runtime: {
      ...runtime,
      wabaMatches: runtime.wabaId === waba.id,
      phoneMatches: runtime.phoneNumberId === phone.id,
    },
    activationRequired: true,
    nextStep:
      "Update the client runtime WABA/phone credentials, enable coexistence only after verification, then configure the coexistence webhook subscription.",
  };
}

module.exports = {
  EMBEDDED_SIGNUP_TYPE,
  FINISH_EVENT,
  WhatsAppCoexistenceOnboardingError,
  choosePhoneNumber,
  completeEmbeddedSignup,
  exchangeCodeForToken,
  fetchPhoneNumbers,
  fetchWaba,
  inspectToken,
  publicConfig,
  safeSessionInfo,
  validateFinishSession,
};
