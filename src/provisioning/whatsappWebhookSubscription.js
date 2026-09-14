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

async function graphRequest({
  path,
  method = "GET",
  accessToken,
  body = null,
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://graph.facebook.com/${normalizedGraphVersion(graphVersion)}/${path.replace(/^\/+/, "")}`;
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
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
    if (err?.name === "AbortError") {
      throw new WhatsAppWebhookSubscriptionError("Meta Graph API request timed out.", {
        code: "WHATSAPP_WEBHOOK_GRAPH_TIMEOUT",
        retrySafe: true,
      });
    }
    throw new WhatsAppWebhookSubscriptionError(
      `Meta Graph API request failed: ${err?.message || String(err)}`,
      {
        code: "WHATSAPP_WEBHOOK_GRAPH_REQUEST_FAILED",
        retrySafe: true,
        cause: err,
      },
    );
  } finally {
    clearTimeout(timeout);
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
    path: `${encodeURIComponent(credentials.wabaId)}/subscribed_apps`,
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

function subscriptionMatchesCallback(subscription, callbackUrl) {
  const actual = text(
    subscription?.override_callback_uri
      || subscription?.overrideCallbackUri
      || subscription?.override_callback_url,
  );
  if (!actual) return false;
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
  graphVersion = DEFAULT_GRAPH_API_VERSION,
  fetchImpl = global.fetch,
}) {
  const credentials = requireCredentials({ wabaId, accessToken, verifyToken });
  const callbackUrl = whatsappCallbackUrl(clientBaseUrl);

  await graphRequest({
    path: `${encodeURIComponent(credentials.wabaId)}/subscribed_apps`,
    method: "POST",
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
    body: {
      override_callback_uri: callbackUrl,
      verify_token: credentials.verifyToken,
    },
  });

  const subscriptions = await getWabaSubscriptions({
    wabaId: credentials.wabaId,
    accessToken: credentials.accessToken,
    graphVersion,
    fetchImpl,
  });
  const matched = subscriptions.find((subscription) =>
    subscriptionMatchesCallback(subscription, callbackUrl),
  );

  if (!matched) {
    throw new WhatsAppWebhookSubscriptionError(
      "Meta accepted the WABA subscription request, but the expected callback override was not confirmed by the follow-up check.",
      {
        code: "WHATSAPP_WEBHOOK_OVERRIDE_NOT_CONFIRMED",
        retrySafe: true,
      },
    );
  }

  return {
    wabaId: credentials.wabaId,
    callbackUrl,
    confirmed: true,
  };
}

module.exports = {
  DEFAULT_GRAPH_API_VERSION,
  DEFAULT_TIMEOUT_MS,
  WhatsAppWebhookSubscriptionError,
  configureWhatsAppWebhook,
  getWabaSubscriptions,
  graphRequest,
  normalizedGraphVersion,
  normalizedHttpsBaseUrl,
  requireCredentials,
  subscriptionMatchesCallback,
  whatsappCallbackUrl,
};
