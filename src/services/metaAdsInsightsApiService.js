const {
  MetaAdsApiError,
  graphApiVersion,
  isConfigurationGraphFailure,
  isRetryableGraphFailure,
  marketingAccessToken,
  requestTimeoutMs,
} = require("./metaAdsApiService");

const INSIGHT_FIELDS = [
  "date_start",
  "date_stop",
  "account_id",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "frequency",
  "actions",
].join(",");

const DEFAULT_PAGE_LIMIT = 500;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanAccountId(value) {
  const text = String(value || "").trim().replace(/^act_/i, "");
  return /^\d+$/.test(text) ? text : null;
}

function cleanId(value) {
  const text = String(value || "").trim();
  return /^\d+$/.test(text) ? text : null;
}

function cleanText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function numeric(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value) {
  const parsed = numeric(value, 0);
  return Math.max(0, Math.trunc(parsed));
}

function validDate(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function buildInsightsUrl(
  accountId,
  { since, until, version = graphApiVersion(), limit = DEFAULT_PAGE_LIMIT } = {}
) {
  const normalizedAccountId = cleanAccountId(accountId);
  if (!normalizedAccountId) {
    throw new MetaAdsApiError("Meta ad account ID is missing or invalid.", {
      retryable: false,
    });
  }
  if (!validDate(since) || !validDate(until) || since > until) {
    throw new MetaAdsApiError("Meta Ads Insights date range is invalid.", {
      retryable: false,
    });
  }

  const params = new URLSearchParams({
    fields: INSIGHT_FIELDS,
    level: "ad",
    time_increment: "1",
    limit: String(limit),
    time_range: JSON.stringify({ since, until }),
  });
  return `https://graph.facebook.com/${version}/act_${normalizedAccountId}/insights?${params.toString()}`;
}

function normalizeInsightRow(row, expectedAccountId) {
  const accountId = cleanAccountId(row?.account_id) || cleanAccountId(expectedAccountId);
  const date = cleanText(row?.date_start);
  const adId = cleanId(row?.ad_id);

  if (!accountId || !date || !validDate(date) || !adId) {
    throw new MetaAdsApiError(
      "Meta Ads Insights returned a row without a valid account, date, or ad ID.",
      { code: "INVALID_INSIGHT_ROW", retryable: true }
    );
  }

  return {
    accountId,
    date,
    campaignId: cleanId(row?.campaign_id),
    campaignName: cleanText(row?.campaign_name),
    adsetId: cleanId(row?.adset_id),
    adsetName: cleanText(row?.adset_name),
    adId,
    adName: cleanText(row?.ad_name),
    spend: numeric(row?.spend, 0),
    impressions: integer(row?.impressions),
    reach: integer(row?.reach),
    clicks: integer(row?.clicks),
    ctr: numeric(row?.ctr),
    cpc: numeric(row?.cpc),
    cpm: numeric(row?.cpm),
    frequency: numeric(row?.frequency),
    actions: Array.isArray(row?.actions) ? row.actions : [],
  };
}

function graphErrorText(data, fallback) {
  return cleanText(data?.error?.error_user_msg)
    || cleanText(data?.error?.message)
    || fallback;
}

function safePagingUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MetaAdsApiError("Meta Ads Insights returned an invalid paging URL.", {
      code: "INVALID_PAGING_URL",
      retryable: true,
    });
  }
  if (url.protocol !== "https:" || url.hostname !== "graph.facebook.com") {
    throw new MetaAdsApiError("Meta Ads Insights returned an unexpected paging host.", {
      code: "INVALID_PAGING_HOST",
      retryable: false,
    });
  }

  // Meta can include the token in paging.next. Keep credentials in the
  // Authorization header instead of copying them into URLs/loggable strings.
  url.searchParams.delete("access_token");
  return url.toString();
}

async function requestPage(
  url,
  {
    fetchImpl = globalThis.fetch,
    token = marketingAccessToken(),
    timeoutMs = requestTimeoutMs(),
  } = {}
) {
  if (!String(token || "").trim()) {
    throw new MetaAdsApiError(
      "Meta Marketing API is not configured. Set META_MARKETING_ACCESS_TOKEN.",
      { code: "NOT_CONFIGURED", retryable: false, configurationError: true }
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new MetaAdsApiError("No fetch implementation is available.", {
      retryable: true,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
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
        graphErrorText(data, raw || `Meta Marketing API returned HTTP ${response.status}.`),
        {
          status: response.status,
          code,
          subcode,
          retryable: isRetryableGraphFailure(response.status, code),
          configurationError: isConfigurationGraphFailure(code),
        }
      );
    }

    return data;
  } catch (err) {
    if (err instanceof MetaAdsApiError) throw err;
    if (err?.name === "AbortError") {
      throw new MetaAdsApiError("Meta Ads Insights request timed out.", {
        code: "TIMEOUT",
        retryable: true,
      });
    }
    throw new MetaAdsApiError(err?.message || "Meta Ads Insights request failed.", {
      code: "NETWORK_ERROR",
      retryable: true,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAdInsights(
  accountId,
  {
    since,
    until,
    fetchImpl = globalThis.fetch,
    token = marketingAccessToken(),
    version = graphApiVersion(),
    timeoutMs = requestTimeoutMs(),
  } = {}
) {
  const normalizedAccountId = cleanAccountId(accountId);
  let nextUrl = buildInsightsUrl(normalizedAccountId, { since, until, version });
  const rows = [];

  while (nextUrl) {
    const data = await requestPage(nextUrl, { fetchImpl, token, timeoutMs });
    if (!Array.isArray(data?.data)) {
      throw new MetaAdsApiError("Meta Ads Insights returned an invalid response.", {
        code: "INVALID_INSIGHTS_RESPONSE",
        retryable: true,
      });
    }
    for (const row of data.data) {
      rows.push(normalizeInsightRow(row, normalizedAccountId));
    }
    nextUrl = safePagingUrl(data?.paging?.next);
  }

  return rows;
}

module.exports = {
  DEFAULT_PAGE_LIMIT,
  INSIGHT_FIELDS,
  buildInsightsUrl,
  cleanAccountId,
  fetchAdInsights,
  normalizeInsightRow,
  requestPage,
  safePagingUrl,
};
