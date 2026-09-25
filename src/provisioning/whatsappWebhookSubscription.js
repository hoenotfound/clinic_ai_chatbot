const crypto = require("crypto");

const DEFAULT_GRAPH_API_VERSION = "v26.0";
const DEFAULT_TIMEOUT_MS = 10000;

class WhatsAppWebhookSubscriptionError extends Error {
  constructor(message, {
    code = "WHATSAPP_WEBHOOK_SUBSCRIPTION_FAILED",
    status = null,
    retrySafe = true,
    cause = null,
  } = {}) {
    super(message);
    this.name = "WhatsAppWebhookSubscriptionError";
    this.code = code;
    this.status = status;
    this.retrySafe = retrySafe;
    this.cause = cause || null;
  }
}

function text(value) {
  return String(value || "").trim();
}

function normalizedGraphVersion(value) {
  const version = text(value) || DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) {
    throw new WhatsAppWebhookSubscriptionError(`Invalid Meta Graph API version: ${version}.`, {
      code: "WHATSAPP_WEBHOOK_GRAPH_VERSION_INVALID",
      retrySafe: true,
    });
  }
  return version;
}

function normalizedHttpsBaseUrl(value) {
  const raw = text(value);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new WhatsAppWebhookSubscriptionError("A valid client public URL is required.", {
      code: "WHATSAPP_WEBHOOK_CLIENT_URL_INVALID",
    });
  }
  if (parsed.username || parsed.password) {
    throw new WhatsAppWebhookSubscriptionError("The client public URL must not contain credentials.", {
      code: "WHATSAPP_WEBHOOK_CLIENT_URL_INVALID",
    });
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new WhatsAppWebhookSubscriptionError("The client public URL must use HTTPS.", {
      code: "WHATSAPP_WEBHOOK_CLIENT_URL_HTTPS_REQUIRED",
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function whatsappCallbackUrl(baseUrl) {
  return `${normalizedHttpsBaseUrl(baseUrl)}/webhook`;
}

function requireCredentials({ wabaId, accessToken, verifyToken }) {
  const values = {
    wabaId: text(wabaId),
    accessToken: text(accessToken),
    verifyToken: text(verifyToken),
  };
  const missing = [];
  if (!values.wabaId) missing.push("WHATSAPP_WABA_ID");
  if (!values.accessToken) missing.push("WHATSAPP_TOKEN");
  if (!values.verifyToken) missing.push("WHATSAPP_VERIFY_TOKEN");
  if (missing.length) {
    throw new WhatsAppWebhookSubscriptionError(
      `WhatsApp webhook configuration is missing: ${missing.join(", ")}.`,
      { code: "WHATSAPP_WEBHOOK_CONFIG_MISSING" },
    );
  }
  return values;
}

async function fetchWithTimeout(url, options, {
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timeoutMessage = "Request timed out.",
  timeoutCode = "WHATSAPP_WEBHOOK_REQUEST_TIMEOUT",
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new WhatsAppWebhookSubscriptionError(timeoutMessage, {
        code: timeoutCode,
        retrySafe: true,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyClientWebhookEndpoint({
  callbackUrl,
  verifyToken,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const url = new URL(callbackUrl);
  const challenge = `da-${crypto.randomBytes(12).toString("hex")}`;
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", text(verifyToken));
  url.searchParams.set("hub.challenge", challenge);

  let response;
  try {
    response = await fetchWithTimeout(url.toString(), { method: "GET" }, {
      fetchImpl,
      timeoutMs,
      timeoutMessage: "The client WhatsApp webhook verification endpoint timed out.",
      timeoutCode: "WHATSAPP_WEBHOOK_ENDPOINT_TIMEOUT",
    });
  } catch (err) {
    if (err instanceof WhatsAppWebhookSubscriptionError) throw err;
    throw new WhatsAppWebhookSubscriptionError(
      `Could not reach the client WhatsApp webhook verification endpoint: ${err?.message || String(err)}`,
      {
        code: "WHATSAPP_WEBHOOK_ENDPOINT_UNREACHABLE",
        retrySafe: true,
        cause: err,
      },
    );
  }

  const responseText = await response.text().catch(() => "");
  if (!response.ok || responseText !== challenge) {
    throw new WhatsAppWebhookSubscriptionError(
      `Client WhatsApp webhook verification failed before Meta configuration (HTTP ${response.status}).`,
      {
        code: "WHATSAPP_WEBHOOK_ENDPOINT_VERIFY_FAILED",
        status: response.status,
        retrySafe: true,
      },
    );
  }
  return true;
}

async function graphRequest({
  path,
  method = "GET",
  accessToken,
  body = null,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const url = `https://graph.facebook.com/${normalizedGraphVersion(graphVersion)}/${path.replace(/^\/+/, "")}`;
  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, {
      fetchImpl,
      timeoutMs,
      timeoutMessage: "Meta Graph API request timed out.",
      timeoutCode: "WHATSAPP_WEBHOOK_GRAPH_TIMEOUT",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      const providerMessage = text(
        payload?.error?.error_user_msg || payload?.error?.message || payload?.message,
      );
      throw new WhatsAppWebhookSubscriptionError(
        providerMessage || `Meta Graph API returned HTTP ${response.status}.`,
        {
          code: "WHATSAPP_WEBHOOK_GRAPH_REQUEST_FAILED",
          status: response.status,
          retrySafe: response.status >= 500 || response.status === 429,
        },
      );
    }
    return payload;
  } catch (err) {
    if (err instanceof WhatsAppWebhookSubscriptionError) throw err;
    throw new WhatsAppWebhookSubscriptionError(
      `Meta Graph API request failed: ${err?.message || String(err)}`,
      {
        code: "WHATSAPP_WEBHOOK_GRAPH_REQUEST_FAILED",
        retrySafe: true,
        cause: err,
      },
    );
  }
}

async function getWabaSubscriptions({
  wabaId,
  accessToken,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
}) {
  const credentials = requireCredentials({
    wabaId,
    accessToken,
    verifyToken: "not-needed-for-read",
  });
  const payload = await graphRequest({
    path: `${encodeURIComponent(credentials.wabaId)}/subscribed_apps?limit=100`,
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

function subscriptionAppId(subscription) {
  return text(
    subscription?.whatsapp_business_api_data?.id
      || subscription?.id,
  ) || null;
}

function subscriptionMatchesCallback(subscription, callbackUrl, appId = null) {
  const actual = text(
    subscription?.override_callback_uri
      || subscription?.overrideCallbackUri
      || subscription?.override_callback_url,
  );
  if (!actual) return false;
  const expectedAppId = text(appId);
  if (expectedAppId && subscriptionAppId(subscription) !== expectedAppId) return false;
  try {
    return normalizedHttpsBaseUrl(actual) === normalizedHttpsBaseUrl(callbackUrl);
  } catch (_) {
    return actual.replace(/\/+$/, "") === callbackUrl.replace(/\/+$/, "");
  }
}

async function configureWhatsAppWebhook({
  wabaId,
  accessToken,
  verifyToken,
  clientBaseUrl,
  appId = null,
  coexistence = false,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
}) {
  const credentials = requireCredentials({ wabaId, accessToken, verifyToken });
  const callbackUrl = whatsappCallbackUrl(clientBaseUrl);

  // Catch a wrong Render URL or mismatched verify token before mutating the
  // WABA subscription. This mirrors Meta's own verification handshake.
  await verifyClientWebhookEndpoint({
    callbackUrl,
    verifyToken: credentials.verifyToken,
    fetchImpl,
  });

  await graphRequest({
    path: `${encodeURIComponent(credentials.wabaId)}/subscribed_apps`,
    method: "POST",
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
    body: {
      override_callback_uri: callbackUrl,
      verify_token: credentials.verifyToken,
      ...(coexistence
        ? {
            subscribed_fields: [
              "messages",
              "smb_message_echoes",
              "smb_app_state_sync",
              "history",
            ],
          }
        : {}),
    },
  });

  const subscriptions = await getWabaSubscriptions({
    wabaId: credentials.wabaId,
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
  });
  const matched = subscriptions.find((subscription) =>
    subscriptionMatchesCallback(subscription, callbackUrl, appId),
  );

  if (!matched) {
    const appHint = text(appId) ? ` for Meta app ${text(appId)}` : "";
    throw new WhatsAppWebhookSubscriptionError(
      `Meta accepted the WABA subscription request, but the expected callback override${appHint} was not confirmed by the follow-up check.`,
      {
        code: "WHATSAPP_WEBHOOK_OVERRIDE_NOT_CONFIRMED",
        retrySafe: true,
      },
    );
  }

  return {
    wabaId: credentials.wabaId,
    appId: subscriptionAppId(matched),
    callbackUrl,
    ...(coexistence ? { coexistence: true } : {}),
    confirmed: true,
  };
}

module.exports = {
  DEFAULT_GRAPH_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  WhatsAppWebhookSubscriptionError,
  configureWhatsAppWebhook,
  fetchWithTimeout,
  getWabaSubscriptions,
  graphRequest,
  normalizedGraphVersion,
  normalizedHttpsBaseUrl,
  requireCredentials,
  subscriptionAppId,
  subscriptionMatchesCallback,
  verifyClientWebhookEndpoint,
  whatsappCallbackUrl,
};
