const { pool } = require("../db/db");
const setupStatusRepo = require("../db/setupStatusRepo");
const aiService = require("./aiService");
const mediaStorage = require("./mediaStorageService");

const GRAPH_API_VERSION = "v26.0";
const DEFAULT_TIMEOUT_MS = 8000;

function text(value) {
  return String(value || "").trim();
}

function configured(...values) {
  return values.every((value) => Boolean(text(value)));
}

function marketingGraphVersion(env) {
  const value = text(env.META_MARKETING_API_VERSION);
  return /^v\d+\.\d+$/.test(value) ? value : GRAPH_API_VERSION;
}

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function result(key, status, summary, checkedAt, extra = {}) {
  return { key, status, summary, checkedAt: iso(checkedAt), ...extra };
}

function safeError(err, fallback = "Connection check failed.", secrets = []) {
  let message = text(err?.safeMessage || err?.message || fallback)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [hidden]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[hidden]")
    .replace(/([?&](?:access_token|api_key|key|token)=)[^&\s]+/gi, "$1[hidden]");
  for (const secret of secrets) {
    const privateValue = text(secret);
    if (privateValue.length >= 6) message = message.split(privateValue).join("[hidden]");
  }
  return message.slice(0, 280) || fallback;
}

async function requestJson(
  url,
  { fetchImpl, token = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json" } : undefined,
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || body?.error) {
      const reason = body?.description || body?.error?.error_user_msg || body?.error?.message;
      const error = new Error(reason || `Provider returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return body?.result || body;
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeoutError = new Error("Connection check timed out.");
      timeoutError.code = "CHECK_TIMEOUT";
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function definitions(env = process.env) {
  const geminiKeyCount = aiService.getGeminiApiKeys(env).length;
  const aiCandidates = aiService.getCandidateHealthDescriptors(env);
  const aiProvider = ["gemini", "claude"].includes(text(env.AI_PROVIDER).toLowerCase())
    ? text(env.AI_PROVIDER).toLowerCase()
    : "gemini";
  const facebookConfigured = configured(env.FACEBOOK_PAGE_ID, env.FACEBOOK_PAGE_ACCESS_TOKEN);
  const instagramConfigured = configured(env.INSTAGRAM_PAGE_ID, env.INSTAGRAM_PAGE_ACCESS_TOKEN);

  return [
    { key: "database", group: "Core system", label: "Database", optional: false, isConfigured: true },
    { key: "security", group: "Core system", label: "Session security", optional: false, isConfigured: Boolean(text(env.SESSION_SECRET)) },
    { key: "public_url", group: "Core system", label: "Public address", optional: false, isConfigured: Boolean(text(env.PUBLIC_BASE_URL)) },
    { key: "admin_account", group: "Core system", label: "Administrator account", optional: false, isConfigured: true },
    {
      key: "ai",
      group: "AI",
      label: "AI reply engine",
      optional: false,
      isConfigured: aiProvider === "claude"
        ? Boolean(text(env.ANTHROPIC_API_KEY) || geminiKeyCount)
        : Boolean(geminiKeyCount || text(env.ANTHROPIC_API_KEY)),
      meta: { aiProvider, geminiKeyCount, claudeFallback: Boolean(text(env.ANTHROPIC_API_KEY)) },
      aiCandidates,
    },
    { key: "whatsapp", group: "Messaging channels", label: "WhatsApp", optional: false, isConfigured: configured(env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_TOKEN) },
    { key: "whatsapp_webhook", group: "Messaging channels", label: "WhatsApp webhook", optional: false, isConfigured: configured(env.WHATSAPP_APP_SECRET, env.WHATSAPP_VERIFY_TOKEN) },
    { key: "facebook", group: "Messaging channels", label: "Facebook Messenger", optional: true, isConfigured: facebookConfigured },
    { key: "instagram", group: "Messaging channels", label: "Instagram", optional: true, isConfigured: instagramConfigured },
    { key: "meta_webhook", group: "Messaging channels", label: "Facebook & Instagram webhook", optional: true, isConfigured: (facebookConfigured || instagramConfigured) && configured(env.META_APP_SECRET, env.META_VERIFY_TOKEN) },
    { key: "r2", group: "Supporting services", label: "Media storage", optional: false, isConfigured: configured(env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET_NAME) },
    { key: "telegram", group: "Supporting services", label: "Telegram alerts", optional: true, isConfigured: text(env.TELEGRAM_ALERTS_ENABLED).toLowerCase() === "true" && configured(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID) },
    { key: "meta_marketing", group: "Supporting services", label: "Meta Ads enrichment", optional: true, isConfigured: Boolean(text(env.META_MARKETING_ACCESS_TOKEN)) },
  ];
}

function mapStored(rows) {
  return new Map((rows || []).map((row) => [row.check_key, row]));
}

function mergeWebhookEvidence(storedRows, inboundRows) {
  const rows = new Map(
    (storedRows || []).map((row) => [row.check_key, { ...row }])
  );
  for (const activity of inboundRows || []) {
    const key = activity.channel === "whatsapp"
      ? "whatsapp_webhook"
      : ["facebook", "instagram"].includes(activity.channel)
        ? "meta_webhook"
        : null;
    const candidate = iso(activity.last_inbound_at);
    if (!key || !candidate) continue;

    const previous = rows.get(key) || { check_key: key };
    const previousAt = iso(previous.last_webhook_at);
    if (!previousAt || new Date(candidate) > new Date(previousAt)) {
      rows.set(key, { ...previous, last_webhook_at: candidate });
    }
  }
  return [...rows.values()];
}

function sessionSecurityResult(env, checkedAt) {
  const secret = text(env.SESSION_SECRET);
  const weak = secret.length < 32 || /^(change|secret|password|test)/i.test(secret);
  return result(
    "security",
    weak ? "error" : "ready",
    weak
      ? "Use a random session secret of at least 32 characters."
      : "A suitably long session secret is configured.",
    checkedAt
  );
}

function publicUrlResult(env, requestBaseUrl, checkedAt) {
  const configuredUrl = text(env.PUBLIC_BASE_URL);
  const detectedUrl = text(requestBaseUrl);
  const candidate = configuredUrl || detectedUrl;
  let parsed = null;
  try {
    parsed = candidate ? new URL(candidate) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    return result("public_url", "error", "No valid public application address was detected.", checkedAt);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    return result("public_url", "warning", "The detected public address is not using HTTPS.", checkedAt);
  }
  return result(
    "public_url",
    "ready",
    configuredUrl
      ? "The public application address is configured."
      : "Address detected from this request. Set PUBLIC_BASE_URL for reliable links in alerts.",
    checkedAt,
    { displayValue: `${parsed.protocol}//${parsed.host}` }
  );
}

function webhookResult(definition, stored, checkedAt) {
  if (!definition.isConfigured) {
    return result(
      definition.key,
      definition.optional ? "not_configured" : "error",
      definition.optional
        ? "Optional integration is not configured."
        : "Webhook secret or verification token is missing.",
      checkedAt
    );
  }
  const lastWebhookAt = iso(stored?.last_webhook_at);
  return result(
    definition.key,
    lastWebhookAt ? "ready" : "warning",
    lastWebhookAt
      ? "A valid signed webhook has been received."
      : "Configured, but no valid webhook has been recorded since this checker was installed.",
    checkedAt,
    { lastWebhookAt }
  );
}

function mergeOverview(
  defs,
  storedRows,
  currentResults,
  env,
  requestBaseUrl,
  nowValue,
  aiCandidateRows = []
) {
  const stored = mapStored(storedRows);
  const current = new Map((currentResults || []).map((item) => [item.key, item]));
  const storedCandidates = new Map(
    (aiCandidateRows || []).map((row) => [row.candidate_key, row])
  );
  const checkedAt = iso(nowValue);
  const checks = defs.map((definition) => {
    let item = current.get(definition.key);
    const saved = stored.get(definition.key);

    if (definition.key === "security") item ||= sessionSecurityResult(env, checkedAt);
    if (definition.key === "public_url") item ||= publicUrlResult(env, requestBaseUrl, checkedAt);
    if (["whatsapp_webhook", "meta_webhook"].includes(definition.key)) {
      item ||= webhookResult(definition, saved, checkedAt);
    }
    if (!item && !definition.isConfigured) {
      item = result(
        definition.key,
        definition.optional ? "not_configured" : "error",
        definition.optional
          ? "Optional integration is not configured."
          : "Required configuration is missing.",
        null
      );
    }
    if (!item && saved?.last_check_status) {
      item = result(
        definition.key,
        saved.last_check_status,
        saved.last_check_summary || "Previously checked.",
        saved.last_checked_at
      );
    }
    item ||= result(definition.key, "warning", "Configured, but not checked yet.", null);

    const merged = {
      ...definition.meta,
      key: definition.key,
      group: definition.group,
      label: definition.label,
      optional: definition.optional,
      configured: definition.isConfigured,
      ...item,
      lastSuccessAt: iso(saved?.last_success_at),
      lastWebhookAt: item.lastWebhookAt || iso(saved?.last_webhook_at),
    };
    if (definition.key === "ai") {
      merged.candidateHealth = (definition.aiCandidates || []).map((candidate) => {
        const savedCandidate = storedCandidates.get(candidate.healthKey);
        return {
          provider: candidate.provider,
          label: candidate.label,
          status: savedCandidate?.last_status || "not_checked",
          failureKind: savedCandidate?.last_failure_kind || null,
          lastAttemptAt: iso(savedCandidate?.last_attempt_at),
          lastSuccessAt: iso(savedCandidate?.last_success_at),
          lastFailureAt: iso(savedCandidate?.last_failure_at),
          lastRateLimitedAt: iso(savedCandidate?.last_rate_limited_at),
        };
      });
    }
    return merged;
  });

  const required = checks.filter((item) => !item.optional);
  const lastRunCandidates = (currentResults?.length ? currentResults : storedRows || [])
    .map((item) => iso(item.checkedAt || item.last_checked_at))
    .filter(Boolean)
    .sort();
  return {
    checkedAt,
    lastRunAt: lastRunCandidates.at(-1) || null,
    checks,
    summary: {
      requiredReady: required.filter((item) => item.status === "ready").length,
      requiredTotal: required.length,
      attention: checks.filter((item) => ["warning", "error"].includes(item.status)).length,
      optionalNotConfigured: checks.filter((item) => item.optional && item.status === "not_configured").length,
    },
  };
}

function createSetupStatusService({
  database = pool,
  repository = setupStatusRepo,
  ai = aiService,
  storage = mediaStorage,
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => new Date(),
} = {}) {
  const secrets = [
    env.GEMINI_API_KEY,
    env.GEMINI_API_KEYS,
    env.GEMINI_API_KEY_1,
    env.GEMINI_API_KEY_2,
    env.GEMINI_API_KEY_3,
    env.GEMINI_API_KEY_4,
    env.GEMINI_API_KEY_5,
    env.ANTHROPIC_API_KEY,
    env.WHATSAPP_TOKEN,
    env.WHATSAPP_APP_SECRET,
    env.WHATSAPP_VERIFY_TOKEN,
    env.FACEBOOK_PAGE_ACCESS_TOKEN,
    env.INSTAGRAM_PAGE_ACCESS_TOKEN,
    env.META_APP_SECRET,
    env.META_VERIFY_TOKEN,
    env.R2_ACCESS_KEY_ID,
    env.R2_SECRET_ACCESS_KEY,
    env.TELEGRAM_BOT_TOKEN,
    env.META_MARKETING_ACCESS_TOKEN,
  ];

  function privateError(err, fallback) {
    return safeError(err, fallback, secrets);
  }

  async function storedRows() {
    let saved = [];
    try {
      saved = await repository.listConnectionHealth(database);
    } catch {
      saved = [];
    }
    if (typeof repository.listLatestInboundActivity !== "function") return saved;
    try {
      const inbound = await repository.listLatestInboundActivity(database);
      return mergeWebhookEvidence(saved, inbound);
    } catch {
      return saved;
    }
  }

  async function aiCandidateRows() {
    let persisted = [];
    try {
      if (typeof repository.listAiCandidateHealth === "function") {
        persisted = await repository.listAiCandidateHealth(database);
      }
    } catch {
      persisted = [];
    }
    const runtime = typeof ai.getRuntimeCandidateHealth === "function"
      ? ai.getRuntimeCandidateHealth()
      : [];
    const combined = new Map(persisted.map((row) => [row.candidate_key, row]));
    for (const row of runtime) {
      const saved = combined.get(row.candidate_key);
      if (!saved || new Date(row.last_attempt_at) >= new Date(saved.last_attempt_at)) {
        combined.set(row.candidate_key, row);
      }
    }
    return [...combined.values()];
  }

  async function getOverview({ requestBaseUrl = null } = {}) {
    const defs = definitions(env);
    const [savedChecks, savedCandidates] = await Promise.all([
      storedRows(),
      aiCandidateRows(),
    ]);
    return mergeOverview(
      defs,
      savedChecks,
      [],
      env,
      requestBaseUrl,
      now(),
      savedCandidates
    );
  }

  async function checkDatabase(checkedAt) {
    try {
      await database.query("SELECT 1 AS ok");
      return result("database", "ready", "PostgreSQL is connected and responding.", checkedAt);
    } catch (err) {
      return result("database", "error", privateError(err, "PostgreSQL connection failed."), checkedAt);
    }
  }

  async function checkAdmin(checkedAt) {
    try {
      const response = await database.query(
        "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active = true"
      );
      const count = Number(response.rows[0]?.count) || 0;
      return result(
        "admin_account",
        count > 0 ? "ready" : "error",
        count > 0
          ? `${count} active administrator account${count === 1 ? " is" : "s are"} available.`
          : "No active administrator account is available.",
        checkedAt
      );
    } catch (err) {
      return result("admin_account", "error", privateError(err, "Administrator check failed."), checkedAt);
    }
  }

  async function checkAi(checkedAt, definition) {
    if (!definition.isConfigured) {
      return result("ai", "error", "No AI provider key is configured.", checkedAt);
    }
    try {
      await ai.getReply(
        [{ role: "user", content: "Private setup check: reply briefly to confirm the assistant is available." }],
        { channel: "whatsapp", isFirstMessage: false }
      );
      return result("ai", "ready", "The AI reply engine completed a private test request.", checkedAt);
    } catch (err) {
      return result("ai", "error", privateError(err, "The AI test request failed."), checkedAt);
    }
  }

  async function checkGraphObject({ key, definition, objectId, token, fields, readyLabel, checkedAt }) {
    if (!definition.isConfigured) {
      return result(
        key,
        definition.optional ? "not_configured" : "error",
        definition.optional ? "Optional integration is not configured." : "Required configuration is missing.",
        checkedAt
      );
    }
    try {
      const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(objectId)}?fields=${encodeURIComponent(fields)}`;
      const data = await requestJson(url, { fetchImpl, token });
      const displayName = text(data?.verified_name || data?.name || data?.display_phone_number);
      return result(
        key,
        "ready",
        displayName ? `${readyLabel}: ${displayName}` : `${readyLabel} is connected.`,
        checkedAt
      );
    } catch (err) {
      return result(key, "error", privateError(err), checkedAt);
    }
  }

  async function checkR2(checkedAt, definition) {
    if (!definition.isConfigured) {
      return result("r2", "error", "R2 media storage configuration is incomplete.", checkedAt);
    }
    let key = null;
    try {
      key = await storage.uploadMedia(
        Buffer.from("clinic-ai-setup-check", "utf8"),
        "text/plain",
        { contactId: "setup-check" }
      );
      await storage.deleteMedia(key);
      key = null;
      return result("r2", "ready", "A private test object was uploaded and deleted successfully.", checkedAt);
    } catch (err) {
      if (key) await storage.deleteMedia(key).catch(() => {});
      return result("r2", "error", privateError(err, "R2 media storage check failed."), checkedAt);
    }
  }

  async function checkTelegram(checkedAt, definition) {
    if (!definition.isConfigured) {
      return result("telegram", "not_configured", "Telegram alerts are optional and currently disabled.", checkedAt);
    }
    try {
      const botToken = text(env.TELEGRAM_BOT_TOKEN);
      const bot = await requestJson(`https://api.telegram.org/bot${botToken}/getMe`, { fetchImpl });
      await requestJson(
        `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(text(env.TELEGRAM_CHAT_ID))}`,
        { fetchImpl }
      );
      return result(
        "telegram",
        "ready",
        bot?.username ? `Connected as @${bot.username}. No message was sent.` : "Telegram bot and chat are accessible. No message was sent.",
        checkedAt
      );
    } catch (err) {
      return result("telegram", "error", privateError(err, "Telegram connection check failed."), checkedAt);
    }
  }

  async function checkMetaMarketing(checkedAt, definition) {
    if (!definition.isConfigured) {
      return result("meta_marketing", "not_configured", "Meta Ads enrichment is optional and not configured.", checkedAt);
    }
    try {
      const graphVersion = marketingGraphVersion(env);
      await requestJson(
        `https://graph.facebook.com/${graphVersion}/me?fields=id%2Cname`,
        { fetchImpl, token: text(env.META_MARKETING_ACCESS_TOKEN) }
      );

      let adId = null;
      try {
        const storedAd = await database.query(
          `SELECT meta_ad_id
           FROM lead_attributions
           WHERE meta_ad_id ~ '^[0-9]+$'
           ORDER BY attributed_at DESC, id DESC
           LIMIT 1`
        );
        adId = text(storedAd.rows[0]?.meta_ad_id);
      } catch {
        return result(
          "meta_marketing",
          "warning",
          "Token accepted, but stored Meta Ad access could not be checked.",
          checkedAt
        );
      }

      if (!adId) {
        return result(
          "meta_marketing",
          "warning",
          "Token accepted. Capture a Meta Ad ID to confirm ads_read and ad account access.",
          checkedAt
        );
      }

      try {
        const ad = await requestJson(
          `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(adId)}?fields=id%2Cname%2Caccount_id`,
          { fetchImpl, token: text(env.META_MARKETING_ACCESS_TOKEN) }
        );
        if (text(ad?.id) !== adId) throw new Error("Meta returned an unexpected ad object.");
        return result(
          "meta_marketing",
          "ready",
          "The token can read a captured Meta Ad and its ad account.",
          checkedAt
        );
      } catch (err) {
        return result(
          "meta_marketing",
          "error",
          `Token accepted, but captured Ad access failed. Check ads_read and ad account access. ${privateError(err)}`,
          checkedAt
        );
      }
    } catch (err) {
      return result("meta_marketing", "error", privateError(err), checkedAt);
    }
  }

  async function runAll({ requestBaseUrl = null } = {}) {
    const checkedAt = now();
    const defs = definitions(env);
    const byKey = new Map(defs.map((item) => [item.key, item]));
    const results = await Promise.all([
      checkDatabase(checkedAt),
      Promise.resolve(sessionSecurityResult(env, checkedAt)),
      Promise.resolve(publicUrlResult(env, requestBaseUrl, checkedAt)),
      checkAdmin(checkedAt),
      checkAi(checkedAt, byKey.get("ai")),
      checkGraphObject({
        key: "whatsapp",
        definition: byKey.get("whatsapp"),
        objectId: text(env.WHATSAPP_PHONE_NUMBER_ID),
        token: text(env.WHATSAPP_TOKEN),
        fields: "id,display_phone_number,verified_name",
        readyLabel: "WhatsApp business number",
        checkedAt,
      }),
      checkGraphObject({
        key: "facebook",
        definition: byKey.get("facebook"),
        objectId: text(env.FACEBOOK_PAGE_ID),
        token: text(env.FACEBOOK_PAGE_ACCESS_TOKEN),
        fields: "id,name",
        readyLabel: "Facebook Page",
        checkedAt,
      }),
      checkGraphObject({
        key: "instagram",
        definition: byKey.get("instagram"),
        objectId: text(env.INSTAGRAM_PAGE_ID),
        token: text(env.INSTAGRAM_PAGE_ACCESS_TOKEN),
        fields: "id,name",
        readyLabel: "Instagram-linked Page",
        checkedAt,
      }),
      checkR2(checkedAt, byKey.get("r2")),
      checkTelegram(checkedAt, byKey.get("telegram")),
      checkMetaMarketing(checkedAt, byKey.get("meta_marketing")),
    ]);

    try {
      await repository.saveCheckResults(results, database);
    } catch (err) {
      const databaseResult = results.find((item) => item.key === "database");
      if (databaseResult?.status === "ready") {
        databaseResult.status = "warning";
        databaseResult.summary = "Database responded, but setup check history could not be saved.";
      }
    }

    const [savedChecks, savedCandidates] = await Promise.all([
      storedRows(),
      aiCandidateRows(),
    ]);
    return mergeOverview(
      defs,
      savedChecks,
      results,
      env,
      requestBaseUrl,
      checkedAt,
      savedCandidates
    );
  }

  return { getOverview, runAll };
}

module.exports = {
  createSetupStatusService,
  definitions,
  mergeOverview,
  mergeWebhookEvidence,
  publicUrlResult,
  requestJson,
  safeError,
  sessionSecurityResult,
};
