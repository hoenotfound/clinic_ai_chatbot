"use strict";

// App-default WhatsApp ingress for the existing paid Neutro process.
// Bootstrap/audit only: it must NOT process the personal number's messages,
// change sender activation, issue provider requests, or import history.
const crypto = require("node:crypto");
const { Pool } = require("pg");

const PRIMARY_FIELDS = new Set([
  "messages", "smb_message_echoes", "history", "smb_app_state_sync"
]);
const FORBIDDEN_SECONDARY_SENDS = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED"
];
const DISCONNECTS = new Set([
  "PARTNER_REMOVED", "ACCOUNT_OFFBOARDED", "ACCOUNT_DISCONNECTED",
  "PHONE_NUMBER_REMOVED", "ACCOUNT_DISABLED", "DISCONNECTED"
]);
let qaPool = null;
let qaPoolKey = null;

function enabled(env = process.env) {
  return env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED === "true";
}
function digits(value) {
  return String(value || "").replace(/\D/g, "");
}
function numberId(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}
function requireNumber(value, label) {
  const id = numberId(value);
  if (!id) throw new Error("Missing or invalid " + label);
  return id;
}
function requireE164(value, label) {
  if (typeof value !== "string" || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error("Invalid " + label);
  }
  return value;
}

function configFromEnv(env = process.env) {
  if (!enabled(env)) throw new Error("Paid default router is disabled");
  const appSecret = String(env.WHATSAPP_APP_SECRET || "");
  const metaSecret = String(env.META_APP_SECRET || "");
  const verifyToken = String(env.WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN || "");
  if (appSecret.length < 24 || metaSecret !== appSecret || verifyToken.length < 16) {
    throw new Error("Paid router Meta app verification is incomplete");
  }
  const primaryWaba = requireNumber(env.WHATSAPP_WABA_ID, "primary WABA");
  const primaryPhoneId = requireNumber(env.WHATSAPP_PHONE_NUMBER_ID, "primary phone ID");
  const primaryE164 = requireE164(
    env.WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164, "primary E164"
  );
  const qaE164 = requireE164(
    env.WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164, "QA E164"
  );
  if (digits(primaryE164) === digits(qaE164) || qaE164 === "+60174831336") {
    throw new Error("Secondary QA phone must be independently pinned");
  }
  if (FORBIDDEN_SECONDARY_SENDS.some(key => env[key] === "true")) {
    throw new Error("Personal WhatsApp outbound must stay disabled");
  }
  if (String(env.WHATSAPP_SECONDARY_WABA_ID || "").trim() ||
      String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "").trim()) {
    throw new Error("Bootstrap-only router cannot activate a secondary sender");
  }
  const qaDatabaseUrl = String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL || "");
  const pinnedQaHost = String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST || "")
    .trim().toLowerCase();
  const primaryDatabaseUrl = String(env.DATABASE_URL || "");
  let qaUrl, primaryUrl;
  try {
    qaUrl = new URL(qaDatabaseUrl);
    primaryUrl = new URL(primaryDatabaseUrl);
  } catch (_) {
    throw new Error("Production and QA database connections must be configured");
  }
  if (!["postgres:", "postgresql:"].includes(qaUrl.protocol) ||
      !["postgres:", "postgresql:"].includes(primaryUrl.protocol) ||
      !qaUrl.username || !qaUrl.password || !primaryUrl.hostname ||
      !pinnedQaHost || qaUrl.hostname.toLowerCase() !== pinnedQaHost ||
      !pinnedQaHost.endsWith(".neon.tech") ||
      qaUrl.hostname.toLowerCase() === primaryUrl.hostname.toLowerCase() ||
      qaDatabaseUrl === primaryDatabaseUrl) {
    throw new Error("QA Neon host must be explicitly pinned and separate from production");
  }
  return Object.freeze({
    appSecret, verifyToken, primaryWaba, primaryPhoneId, primaryE164,
    qaE164, qaDatabaseUrl, pinnedQaHost
  });
}

function fingerprint(accountId, entryTime, change) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ account: accountId, entryTime, change }))
    .digest("hex");
}

// Validate the ENTIRE Meta batch before any database write or legacy dispatch.
// Unknown/foreign events fail closed. No fallback to Neutro is possible.
function partitionDefaultBatch(body, config) {
  if (!body || body.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || body.entry.length < 1 ||
      body.entry.length > 200) {
    throw new Error("Invalid Meta WhatsApp batch");
  }
  const primary = [];
  const audits = [];
  let total = 0;
  for (const entry of body.entry) {
    const accountId = requireNumber(entry && entry.id, "entry WABA");
    if (!Array.isArray(entry.changes) || !entry.changes.length ||
        entry.changes.length > 200) {
      throw new Error("Invalid Meta changes array");
    }
    const primaryChanges = [];
    let entryTime = null;
    if (entry.time != null) {
      entryTime = Number(entry.time);
      if (!Number.isSafeInteger(entryTime) || entryTime <= 0) {
        throw new Error("Invalid Meta entry time");
      }
    }
    for (const change of entry.changes) {
      if (++total > 200 || !change || typeof change.field !== "string" ||
          !change.value || typeof change.value !== "object" ||
          Array.isArray(change.value)) {
        throw new Error("Invalid or excessive Meta changes");
      }
      const value = change.value;
      const isPrimary = accountId === config.primaryWaba;
      if (change.field === "account_update") {
        if (typeof value.event !== "string" ||
            !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.event)) {
          throw new Error("Invalid Meta account update");
        }
        const suppliedPhone = value.phone_number;
        if (isPrimary) {
          if (suppliedPhone != null &&
              (typeof suppliedPhone !== "string" ||
               digits(suppliedPhone) !== digits(config.primaryE164))) {
            throw new Error("Primary lifecycle phone mismatch");
          }
        } else if (typeof suppliedPhone !== "string" ||
                   digits(suppliedPhone) !== digits(config.qaE164)) {
          throw new Error("Unknown or unpinned account update");
        }
        audits.push({
          kind: isPrimary ? "primary" : "preidentity",
          fingerprint: fingerprint(accountId, entryTime, change),
          accountId, entryTime, eventType: value.event,
          phone: isPrimary ? (suppliedPhone == null ? null : config.primaryE164)
                           : config.qaE164
        });
        continue;
      }
      if (!isPrimary || !PRIMARY_FIELDS.has(change.field)) {
        throw new Error("Unsupported or foreign Meta event");
      }
      // Customer-related primary events must positively identify Neutro.
      // Do not use the first configured phone as a fallback.
      if (value.metadata?.phone_number_id !== config.primaryPhoneId) {
        throw new Error("Primary message/sync phone ID mismatch or missing");
      }
      primaryChanges.push(change);
    }
    if (primaryChanges.length) primary.push({ ...entry, changes: primaryChanges });
  }
  return {
    primary: primary.length ? { ...body, entry: primary } : null,
    audits
  };
}

// This QA-only pool is deliberately not imported from ../db/db and is not
// part of Neutro startup migrations, workers, or customer repositories.
function getQaPool(config) {
  if (qaPool && qaPoolKey !== config.qaDatabaseUrl) {
    throw new Error("QA Neon database changed during a running process");
  }
  if (!qaPool) {
    qaPoolKey = config.qaDatabaseUrl;
    qaPool = new Pool({
      connectionString: config.qaDatabaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
      statement_timeout: 3000,
      query_timeout: 4000,
      application_name: "da-chatbot-paid-default-qa-audit"
    });
    qaPool.on("error", error => {
      console.error("[Paid default router] QA Neon pool error:", error.code || "unknown");
    });
  }
  return qaPool;
}

async function recordAuditBatch(audits, config, database = getQaPool(config)) {
  if (!audits.length) return { durable: true, inserted: 0 };
  const client = await database.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    // Exact QA schema required: production v077/079 must never receive writes.
    const schema = await client.query(
      "SELECT version, name FROM schema_migrations WHERE version IN (102,103,104)"
    );
    const versions = new Map(schema.rows.map(row => [Number(row.version), row.name]));
    if (versions.get(102) !== "whatsapp_coexistence_preidentity_events" ||
        versions.get(103) !== "whatsapp_legacy_lifecycle_relay_audit" ||
        versions.get(104) !== "whatsapp_coexistence_once_only_and_lifecycle_alerts") {
      throw new Error("QA database migration identity mismatch");
    }
    let inserted = 0;
    for (const audit of audits) {
      if (audit.kind === "primary") {
        const result = await client.query(
          "INSERT INTO whatsapp_legacy_lifecycle_relay_audit " +
          "(fingerprint,account_id,event_type,account_phone_e164,entry_time) " +
          "VALUES($1,$2,$3,$4,$5) ON CONFLICT(fingerprint) DO NOTHING " +
          "RETURNING fingerprint",
          [audit.fingerprint, audit.accountId, audit.eventType,
           audit.phone, audit.entryTime]
        );
        if (result.rowCount === 1) {
          inserted++;
          await client.query(
            "INSERT INTO whatsapp_pr395_legacy_lifecycle_alerts " +
            "(fingerprint,account_id,event_type,severity) VALUES($1,$2,$3,$4) " +
            "ON CONFLICT(fingerprint) DO NOTHING",
            [audit.fingerprint, audit.accountId, audit.eventType,
             DISCONNECTS.has(audit.eventType) ? "critical" : "review"]
          );
        }
      } else if (audit.kind === "preidentity") {
        const result = await client.query(
          "INSERT INTO whatsapp_coexistence_preidentity_events " +
          "(fingerprint,candidate_waba_id,candidate_phone_e164,event_type,entry_time) " +
          "VALUES($1,$2,$3,$4,$5) ON CONFLICT(fingerprint) DO NOTHING " +
          "RETURNING fingerprint",
          [audit.fingerprint, audit.accountId, config.qaE164,
           audit.eventType, audit.entryTime]
        );
        if (result.rowCount === 1) inserted++;
      } else {
        throw new Error("Unsupported audit owner");
      }
    }
    await client.query("COMMIT");
    inTransaction = false;
    return { durable: true, inserted };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function dispatchDefaultWebhook(req, res, primaryHandler, {
  env = process.env, persist = recordAuditBatch
} = {}) {
  if (typeof primaryHandler !== "function") {
    throw new Error("Primary WhatsApp handler is required");
  }
  const config = configFromEnv(env);
  const { primary, audits } = partitionDefaultBatch(req.body, config);
  if (audits.length) {
    const result = await persist(audits, config);
    if (!result || result.durable !== true) {
      throw new Error("QA lifecycle audit was not durable");
    }
  }
  if (!primary) return res.sendStatus(200);
  // Reuse the existing production message handler, with only verified Neutro
  // changes. The original /webhook registration remains unchanged.
  req.body = primary;
  return primaryHandler(req, res);
}

module.exports = {
  enabled, configFromEnv, partitionDefaultBatch, recordAuditBatch,
  dispatchDefaultWebhook
};
