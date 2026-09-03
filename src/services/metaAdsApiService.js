const DEFAULT_GRAPH_API_VERSION = "v26.0";
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const AD_FIELDS = "id,name,account_id,campaign{id,name},adset{id,name}";

class MetaAdsApiError extends Error {
  constructor(
    message,
    {
      status = null,
      code = null,
      subcode = null,
      retryable = false,
      configurationError = false,
    } = {}
  ) {
    super(message);
    this.name = "MetaAdsApiError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.retryable = retryable;
    this.configurationError = configurationError;
  }
}

function marketingAccessToken() {
  return String(process.env.META_MARKETING_ACCESS_TOKEN || "").trim();
}

function graphApiVersion() {
  const configured = String(process.env.META_MARKETING_API_VERSION || "").trim();
  return /^v\d+\.\d+$/.test(configured) ? configured : DEFAULT_GRAPH_API_VERSION;
}

function requestTimeoutMs() {
  const parsed = Number(process.env.META_MARKETING_API_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(parsed), 1000), MAX_TIMEOUT_MS);
}

function configured() {
  return Boolean(marketingAccessToken());
}

function cleanId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function extractGraphError(data, fallback) {
  return cleanText(data?.error?.error_user_msg)
    || cleanText(data?.error?.message)
    || cleanText(data?.message)
    || fallback;
}

function isRetryableGraphFailure(status, code) {
  const numericCode = Number(code);
  return status === 408
    || status === 429
    || status >= 500
    || [1, 2, 4, 17, 32, 613].includes(numericCode);
}

function isConfigurationGraphFailure(code) {
  return [10, 190, 200].includes(Number(code));
}

function buildAdDetailsUrl(adId, version = graphApiVersion()) {
  const normalizedAdId = cleanId(adId);
  if (!normalizedAdId) {
    throw new MetaAdsApiError("Meta ad ID is missing or invalid.", { retryable: false });
  }
  const params = new URLSearchParams({ fields: AD_FIELDS });
  return `https://graph.facebook.com/${version}/${normalizedAdId}?${params.toString()}`;
}

async function fetchAdDetails(
  adId,
  {
    fetchImpl = globalThis.fetch,
    token = marketingAccessToken(),
    version = graphApiVersion(),
    timeoutMs = requestTimeoutMs(),
  } = {}
) {
  const normalizedAdId = cleanId(adId);
  if (!normalizedAdId) {
    throw new MetaAdsApiError("Meta ad ID is missing or invalid.", { retryable: false });
  }
  if (!String(token || "").trim()) {
    throw new MetaAdsApiError(
      "Meta Marketing API is not configured. Set META_MARKETING_ACCESS_TOKEN.",
      { code: "NOT_CONFIGURED", retryable: false, configurationError: true }
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new MetaAdsApiError("No fetch implementation is available.", { retryable: true });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(buildAdDetailsUrl(normalizedAdId, version), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${String(token).trim()}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      const code = data?.error?.code ?? null;
      const subcode = data?.error?.error_subcode ?? null;
      throw new MetaAdsApiError(
        extractGraphError(data, raw || `Meta Marketing API returned HTTP ${response.status}.`),
        {
          status: response.status,
          code,
          subcode,
          retryable: isRetryableGraphFailure(response.status, code),
          configurationError: isConfigurationGraphFailure(code),
        }
      );
    }

    const returnedAdId = cleanId(data?.id);
    if (!returnedAdId || returnedAdId !== normalizedAdId) {
      throw new MetaAdsApiError("Meta Marketing API returned an unexpected ad object.", {
        retryable: true,
      });
    }

    return {
      adId: returnedAdId,
      adName: cleanText(data?.name),
      accountId: cleanId(data?.account_id),
      adsetId: cleanId(data?.adset?.id),
      adsetName: cleanText(data?.adset?.name),
      campaignId: cleanId(data?.campaign?.id),
      campaignName: cleanText(data?.campaign?.name),
    };
  } catch (err) {
    if (err instanceof MetaAdsApiError) throw err;
    if (err?.name === "AbortError") {
      throw new MetaAdsApiError("Meta Marketing API request timed out.", {
        code: "TIMEOUT",
        retryable: true,
      });
    }
    throw new MetaAdsApiError(err?.message || "Meta Marketing API request failed.", {
      code: "NETWORK_ERROR",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  AD_FIELDS,
  DEFAULT_GRAPH_API_VERSION,
  MetaAdsApiError,
  buildAdDetailsUrl,
  configured,
  fetchAdDetails,
  graphApiVersion,
  isConfigurationGraphFailure,
  isRetryableGraphFailure,
  marketingAccessToken,
  requestTimeoutMs,
};
