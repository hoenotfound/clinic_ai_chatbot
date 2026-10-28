"use strict";

// PREPARATION ONLY. Never called by production /webhook or /whatsapp/default.
// Bound, HMAC-verified QA ingress can encrypt-and-stage secondary events,
// but it cannot import chats, start AI, send messages or call Graph APIs.
const crypto = require("node:crypto");
const ingress = require("./whatsappPaidDefaultIngress");
const passiveHistory = require("./whatsappCoexistenceHistoryService");

const ALLOWED_FIELDS = new Set(["messages", "smb_message_echoes", "history", "smb_app_state_sync"]);
const CONSENT_FIELDS = new Set(["history", "smb_app_state_sync"]);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHANGES = 100;
const MAX_RETENTION_HOURS = 72;
const CAPTURE_FLAG = "WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED";

function strictId(x, name) {
  if (typeof x !== "string" || !/^\d{1,32}$/.test(x)) {
    throw Error("Missing or invalid " + name);
  }
  return x;
}
function keyFromEnv(env) {
  const encoded = String(env.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64 || "");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw Error("Secondary capture key must be independently configured");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw Error("Invalid secondary capture key");
  }
  return key;
}
function captureConfig(env = process.env) {
  if (env[CAPTURE_FLAG] !== "true" || env.WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED !== "true") {
    throw Error("Secondary capture is disabled");
  }
  const base = ingress.assertQaConfiguration(ingress.configFromEnv(env));
  const waba = strictId(env.WHATSAPP_PAID_SECONDARY_QA_WABA_ID, "secondary WABA");
  const phoneId = strictId(env.WHATSAPP_PAID_SECONDARY_QA_PHONE_ID, "secondary phone");
  if (waba === base.primaryWaba || phoneId === base.primaryPhoneId) {
    throw Error("Secondary capture cannot use primary Neutro identity");
  }
  if (env.WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164 !== base.qaE164 ||
      env.WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED !== "true" ||
      env.WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED !== "true") {
    throw Error("Capture requires explicit phone, operator approval and verified processing consent");
  }
  const retentionHours = Number(env.WHATSAPP_PAID_SECONDARY_QA_RETENTION_HOURS || "24");
  if (!Number.isInteger(retentionHours) || retentionHours < 1 ||
      retentionHours > MAX_RETENTION_HOURS) {
    throw Error("Invalid QA capture retention");
  }
  return { ...base, waba, phoneId, retentionHours, key: keyFromEnv(env),
    historyConsent: env.WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED === "true" };
}

function classify(body, config) {
  if (body?.object !== "whatsapp_business_account" ||
      !Array.isArray(body.entry) || !body.entry.length ||
      body.entry.length > MAX_CHANGES) {
    throw Error("Invalid WhatsApp secondary batch");
  }
  const jobs = [];
  let count = 0;
  for (const entry of body.entry) {
    if (entry?.id !== config.waba || !Array.isArray(entry.changes)) {
      throw Error("Secondary account identity mismatch");
    }
    if (entry.changes.length < 1 || entry.changes.length > MAX_CHANGES) {
      throw Error("Invalid secondary change count");
    }
    for (const change of entry.changes) {
      if (++count > MAX_CHANGES ||
          !ALLOWED_FIELDS.has(change?.field) ||
          change?.value?.metadata?.phone_number_id !== config.phoneId) {
        throw Error("Unknown field or secondary phone mismatch");
      }
      if (CONSENT_FIELDS.has(change.field) && !config.historyConsent) {
        throw Error("One-time sync requires separately verified history/contact consent");
      }
      // Split large one-time history BEFORE encrypting into QA's 2 MB column.
      // The existing passive import logic uses the same chunk representation.
      const parts = change.field === "history"
        ? passiveHistory.splitHistoryChange(change, 100) : [change];
      for (const part of parts) {
        if (jobs.length >= MAX_CHANGES) throw Error("Excessive secondary history chunks");
        const raw = Buffer.from(JSON.stringify({ entryTime: entry.time ?? null, change: part }), "utf8");
        if (raw.length > MAX_BYTES) throw Error("Secondary payload exceeds bounded capture limit");
        const fingerprint = crypto.createHash("sha256")
          .update(config.waba + ":" + config.phoneId + ":").update(raw).digest("hex");
        jobs.push({ fingerprint, field: part.field, raw });
      }
    }
  }
  return jobs;
}

function encryptJob(job, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(job.fingerprint, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(job.raw), cipher.final()]);
  return {
    fingerprint: job.fingerprint, field: job.field, ciphertext,
    nonce, tag: cipher.getAuthTag(), bytes: job.raw.length
  };
}

// Requires original Meta signature verification at the HTTP middleware.
// Function never stores plaintext in QA Neon and writes no production tables.
async function captureSignedSecondaryBatch(body, {
  env = process.env, database, signatureVerified = false
} = {}) {
  if (signatureVerified !== true) throw Error("Signed Meta webhook signature proof required");
  const config = captureConfig(env);
  const jobs = classify(body, config);
  const pool = database || ingress.getQaPool(config);
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    // Enforce both QA-only schema and an explicitly bound secondary sender.
    const schema = await client.query(
      "SELECT version,name FROM schema_migrations WHERE version IN (102,103,104)"
    );
    const byVersion = new Map(schema.rows.map(r => [Number(r.version), r.name]));
    if (byVersion.get(102) !== "whatsapp_coexistence_preidentity_events" ||
        byVersion.get(103) !== "whatsapp_legacy_lifecycle_relay_audit" ||
        byVersion.get(104) !== "whatsapp_coexistence_once_only_and_lifecycle_alerts") {
      throw Error("QA schema identity mismatch");
    }
    const sender = await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE " +
      "sender_key='coexistence_qa' AND meta_account_id=$1 AND meta_phone_number_id=$2 " +
      "AND state='testing' AND coexistence_enabled=TRUE FOR UPDATE",
      [config.waba, config.phoneId]
    );
    if (sender.rows?.length !== 1) throw Error("No validated secondary testing sender");
    const senderId = sender.rows[0].id;
    let inserted = 0;
    for (const job of jobs) {
      const encrypted = encryptJob(job, config.key);
      const result = await client.query(
        "INSERT INTO whatsapp_secondary_qa_capture_events " +
        "(fingerprint,sender_id,event_field,ciphertext,nonce,auth_tag,payload_bytes,expires_at) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+($8::integer * INTERVAL '1 hour')) " +
        "ON CONFLICT(fingerprint) DO NOTHING RETURNING fingerprint",
        [encrypted.fingerprint,senderId,encrypted.field,encrypted.ciphertext,
         encrypted.nonce,encrypted.tag,encrypted.bytes,config.retentionHours]
      );
      if (result.rowCount === 1) inserted++;
    }
    await client.query("COMMIT");
    began = false;
    return { durable: true, accepted: jobs.length, inserted };
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ALLOWED_FIELDS, captureConfig, classify, captureSignedSecondaryBatch, encryptJob
};
