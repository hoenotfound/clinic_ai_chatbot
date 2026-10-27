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

function secondaryTargetMode(env = process.env) {
  return Boolean(clean(env.WHATSAPP_SECONDARY_SENDER_KEY) ||
    clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) ||
    clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID));
}

function normalizedPhone(value) {
  return clean(value).replace(/[^0-9]/g, "");
}

function unassignedProtectedQaTarget(env = process.env) {
  const pinned = clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164);
  const approved = clean(env.PR395_STAGING_APPROVED_TEST_PHONE_E164);
  const primary = normalizedPhone(env.WHATSAPP_PHONE_NUMBER);
  return env.PR395_STAGING_MODE === "true" &&
    env.PR395_STAGING_APP_ONLY_SIGNUP_READY === "true" &&
    env.PR395_STAGING_PROVIDER_REHEARSAL_ENABLED !== "true" &&
    env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY === "coexistence_qa" &&
    !clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID) &&
    !clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID) &&
    !clean(env.WHATSAPP_SECONDARY_WABA_ID) &&
    /^\+[1-9]\d{7,14}$/.test(pinned) &&
    pinned === approved && pinned !== "+60174831336" &&
    (!primary || normalizedPhone(pinned) !== primary);
}

function requireExpectedSecondaryPhone(env = process.env) {
  if (!secondaryTargetMode(env)) return null;
  // Business App-only phones do not expose their Cloud API phone ID before
  // Meta Embedded Signup. Discover it *after* the signed completion and
  // Graph WABA/phone ownership lookup, but only in locked-down staging.
  if (unassignedProtectedQaTarget(env)) return null;
  const expected = clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID);
  if (!/^\d+$/.test(expected)) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Pin the secondary phone number ID before authorizing a real WhatsApp Business App number.",
      { code: "WHATSAPP_COEXISTENCE_SECONDARY_TARGET_UNPINNED", status: 409, retrySafe: false }
    );
  }
  if (expected === clean(env.WHATSAPP_PHONE_NUMBER_ID)) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The selected secondary phone ID matches Neutro's primary phone ID. No authorization was accepted.",
      { code: "WHATSAPP_COEXISTENCE_PRIMARY_PHONE_BLOCKED", status: 409, retrySafe: false }
    );
  }
  return expected;
}

function assertExpectedSecondaryPhone(phone, env = process.env) {
  const expectedId = requireExpectedSecondaryPhone(env);
  if (!expectedId && !secondaryTargetMode(env)) return;
  const metaId = clean(phone?.id);
  // The account might have been authorized for the wrong Business App
  // number. Even when no Meta phone ID was available pre-signup, verify the
  // actual account-owned phone against the privately pinned E.164.
  if (!/^\d+$/.test(metaId) ||
      metaId === clean(env.WHATSAPP_PHONE_NUMBER_ID) ||
      (unassignedProtectedQaTarget(env) && metaId === "1318355951360575")) {
    throw new WhatsAppCoexistenceOnboardingError(
      "The authorized phone ID is invalid, belongs to the primary account, or matches the excluded clinic test number.",
      { code: "WHATSAPP_COEXISTENCE_SECONDARY_PHONE_MISMATCH", status: 409, retrySafe: false }
    );
  }
  if (expectedId && metaId !== expectedId) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta returned a different phone ID from the pinned secondary number. Verify the new phone ID manually before retrying.",
      { code: "WHATSAPP_COEXISTENCE_SECONDARY_PHONE_MISMATCH", status: 409, retrySafe: false }
    );
  }
  const expectedE164 = normalizedPhone(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164);
  const actualE164 = normalizedPhone(phone?.displayPhoneNumber);
  if (expectedE164 && (!actualE164 || expectedE164 !== actualE164)) {
    throw new WhatsAppCoexistenceOnboardingError(
      "Meta returned a display phone number that does not match the pinned second number.",
      { code: "WHATSAPP_COEXISTENCE_SECONDARY_DISPLAY_MISMATCH", status: 409, retrySafe: false }
    );
  }
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
  const secondary = secondaryTargetMode(env);
  // October 2026: old Embedded Signup configurations no longer support new
  // onboarding. This is an operator confirmation of the Meta dashboard
  // configuration, not something the API can infer from config_id.
  if (secondary && env.META_EMBEDDED_SIGNUP_V4_CONFIRMED !== "true") {
    missing.push("META_EMBEDDED_SIGNUP_V4_CONFIRMED");
  }
  if (secondary && !/^\d+$/.test(clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID)) &&
      !unassignedProtectedQaTarget(env)) {
    missing.push("WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID or protected QA E.164 pin");
  }
  if (secondary && clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID) ===
      clean(env.WHATSAPP_PHONE_NUMBER_ID)) {
    missing.push("A distinct secondary phone number ID");
  }

  return {
    configured: missing.length === 0,
    missing,
    ...values,
    featureType: "whatsapp_business_app_onboarding",
    sessionInfoVersion: "3",
    runtime: {
      targetMode: secondary ? "secondary" : "single-number",
      coexistenceEnabled:
        clean(env.WHATSAPP_COEXISTENCE_ENABLED).toLowerCase() === "true",
      // In the dual-number rollout never compare an onboarding result with
      // Neutro's primary sender or suggest replacing its working credentials.
      wabaId: clean(secondary ? env.WHATSAPP_SECONDARY_WABA_ID : env.WHATSAPP_WABA_ID) || null,
      phoneNumberId: clean(secondary ? env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID : env.WHATSAPP_PHONE_NUMBER_ID) || null,
      expectedPhoneNumberId: secondary ? clean(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID) || null : null,
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
  let payload;
  try {
    payload = await graphRequest({
      path:
        `${encodeURIComponent(wabaId)}/phone_numbers` +
        "?fields=id,display_phone_number,verified_name&limit=100",
      accessToken,
      graphVersion: graphVersion(env),
      fetchImpl,
    });
  } catch (error) {
    // Meta's 2026 WAAC / messaging-account separation can make a formerly
    // assumed WABA ID the wrong Graph node type. Never fall back to the first
    // phone on another account or treat a direct phone lookup as ownership proof.
    if (/phone_numbers|nonexisting field/i.test(String(error?.message || ""))) {
      throw new WhatsAppCoexistenceOnboardingError(
        "Meta did not expose the phone_numbers edge for the authorized account. Confirm the account type and ID returned by Embedded Signup; this authorization is not verified.",
        { code: "WHATSAPP_COEXISTENCE_ACCOUNT_TYPE_UNVERIFIED", status: 409, retrySafe: false }
      );
    }
    throw error;
  }
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
  const expectedPhoneId = requireExpectedSecondaryPhone(env);
  if (secondaryTargetMode(env) && env.META_EMBEDDED_SIGNUP_V4_CONFIRMED !== "true") {
    throw new WhatsAppCoexistenceOnboardingError(
      "Verify that the DA CHATBOT Facebook Login for Business configuration uses Embedded Signup v4 before connecting this Business App number.",
      { code: "WHATSAPP_COEXISTENCE_V4_CONFIG_UNVERIFIED", status: 409, retrySafe: false }
    );
  }
  // Reject the wrong selection BEFORE exchanging Meta's authorization code
  // when the completion event explicitly supplies the phone ID.
  if (expectedPhoneId && finish.phoneNumberId && finish.phoneNumberId !== expectedPhoneId) {
    assertExpectedSecondaryPhone({ id: finish.phoneNumberId }, {
      ...env, WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: ""
    });
  }
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
  assertExpectedSecondaryPhone(phone, env);
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
      accountIdentityRequiresReview: runtime.targetMode === "secondary" &&
        Boolean(runtime.wabaId) && runtime.wabaId !== waba.id,
    },
    activationRequired: true,
    nextStep: runtime.targetMode === "secondary"
      ? "Review and update only the isolated secondary sender account/phone credentials after independent Meta verification. Never replace Neutro's primary credentials, register the Business App phone, enable outbound sending or move the production webhook."
      : "Verify account and phone ownership before changing any runtime credentials or webhook subscriptions.",
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
  fetchPhoneNumbers,
  secondaryTargetMode,
  unassignedProtectedQaTarget,
  requireExpectedSecondaryPhone,
  assertExpectedSecondaryPhone,
  safeSessionInfo,
  validateFinishSession,
};
