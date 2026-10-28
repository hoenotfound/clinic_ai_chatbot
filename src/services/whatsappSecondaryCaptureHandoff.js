"use strict";

// Manual, opt-in handoff from the paid app-default ENCRYPTED QA capture to
// sender-scoped Inbox import jobs. No HTTP routes, Meta calls or send workers.
// Source and target are distinct databases. Marking a capture transferred is
// intentionally AFTER the target has durably staged every history chunk.
// A crash between the commits is safe: target job fingerprints deduplicate.
const crypto = require("node:crypto");
const capture = require("./whatsappSecondaryQaCapture");
const ingress = require("./whatsappPaidDefaultIngress");
const history = require("./whatsappCoexistenceHistoryService");

const FIELDS = new Set(["history", "smb_app_state_sync"]);
function configForHandoff(env = process.env) {
  if (env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED !== "true" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED !== "true") {
    throw Error("Encrypted capture-to-Inbox handoff is disabled");
  }
  // Reuse the capture's explicit owner consent, real-clinic phone pin,
  // unique secondary credentials and independent QA database safeguards.
  const source = capture.captureConfig(env);
  const destinationHost = String(
    env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST || ""
  ).trim().toLowerCase();
  let targetUrl, sourceUrl;
  try {
    targetUrl = new URL(env.DATABASE_URL);
    sourceUrl = new URL(source.qaDatabaseUrl);
  } catch (_) { throw Error("Missing verified handoff database URLs"); }
  if (!destinationHost.endsWith(".neon.tech") ||
      destinationHost !== targetUrl.hostname.toLowerCase() ||
      destinationHost === sourceUrl.hostname.toLowerCase() ||
      !["postgres:", "postgresql:"].includes(targetUrl.protocol) ||
      targetUrl.username.length === 0 || targetUrl.password.length === 0 ||
      (env.PR395_STAGING_MODE !== "true" &&
       env.WHATSAPP_CAPTURE_TO_INBOX_PRODUCTION_APPROVED !== "true")) {
    throw Error("Handoff destination requires its own pinned and approved database");
  }
  // The paid app-default process MUST keep its normal secondary routing
  // disabled. The importer only sees this isolated, explicitly scoped config.
  const importEnv = {
    WHATSAPP_SECONDARY_WABA_ID: source.waba,
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID: source.phoneId,
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: source.qaE164,
    WHATSAPP_SECONDARY_SENDER_KEY: "coexistence_qa",
    WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED: "true",
    WHATSAPP_MULTI_NUMBER_READ_ENABLED: "true",
    WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED: "true",
    WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
    WHATSAPP_WABA_ID: source.primaryWaba,
    WHATSAPP_PHONE_NUMBER_ID: source.primaryPhoneId,
    WHATSAPP_PHONE_NUMBER: source.primaryE164
  };
  return {source, importEnv};
}
function decryptCapturedRow(row, source) {
  if (!FIELDS.has(row.event_field) ||
      !/^[a-f0-9]{64}$/.test(String(row.fingerprint || "")) ||
      !Buffer.isBuffer(row.ciphertext) ||
      !Buffer.isBuffer(row.nonce) || row.nonce.length !== 12 ||
      !Buffer.isBuffer(row.auth_tag) || row.auth_tag.length !== 16 ||
      !Number.isSafeInteger(row.payload_bytes) || row.payload_bytes < 1 ||
      row.payload_bytes > 2097152) throw Error("Invalid encrypted history capture");
  const decipher = crypto.createDecipheriv("aes-256-gcm", source.key, row.nonce);
  decipher.setAAD(Buffer.from(row.fingerprint, "ascii"));
  decipher.setAuthTag(row.auth_tag);
  let clear;
  try {
    clear = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    if (clear.length !== row.payload_bytes)
      throw Error("Encrypted history capture length mismatch");
    const parsed = JSON.parse(clear.toString("utf8"));
    const actual = crypto.createHash("sha256")
      .update(source.waba + ":" + source.phoneId + ":")
      .update(clear).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(actual, "hex"),
      Buffer.from(row.fingerprint, "hex")) ||
      parsed.change?.field !== row.event_field ||
      parsed.change?.value?.metadata?.phone_number_id !== source.phoneId ||
      !Number.isSafeInteger(parsed.entryTime) && parsed.entryTime !== null) {
      throw Error("Encrypted capture identity or fingerprint mismatch");
    }
    return parsed;
  } finally {
    if (clear) clear.fill(0);
  }
}
async function assertStagedJobs(target, importEnv, change) {
  const fingerprints = [...new Set(history.splitHistoryChange(change)
    .map(child => history.fingerprint(importEnv.WHATSAPP_SECONDARY_WABA_ID, child)))];
  if (!fingerprints.length || fingerprints.length > 2000)
    throw Error("Invalid import chunk count");
  const result = await target.query(
    "SELECT count(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs j " +
    "JOIN whatsapp_sender_accounts s ON s.id=j.sender_id " +
    "WHERE j.fingerprint=ANY($1::text[]) AND " +
    "j.status IN ('pending','processing','completed') " +
    "AND s.sender_key=$2 AND s.meta_account_id=$3 AND " +
    "s.meta_phone_number_id=$4 AND s.state='active' AND s.coexistence_enabled=TRUE",
    [fingerprints, importEnv.WHATSAPP_SECONDARY_SENDER_KEY,
      importEnv.WHATSAPP_SECONDARY_WABA_ID,
      importEnv.WHATSAPP_SECONDARY_PHONE_NUMBER_ID]
  );
  if (Number(result.rows?.[0]?.n) !== fingerprints.length)
    throw Error("Not every historical chunk has a durable, usable Inbox job");
}
async function handoffOnce({
  env = process.env, sourceDatabase, targetDatabase, maxEvents = 3,
  stage = history.acceptPassiveSync, importJobs = history.runOnce,
  processInboxJobs = false
} = {}) {
  const {source, importEnv} = configForHandoff(env);
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 10 ||
      !targetDatabase || typeof targetDatabase.query !== "function" ||
      typeof targetDatabase.connect !== "function") {
    throw Error("Handoff requires a bounded run and explicit target database");
  }
  const sourcePool = sourceDatabase || ingress.getQaPool(source);
  if (sourcePool === targetDatabase)
    throw Error("QA encrypted source and Inbox target must be different databases");
  let transferred = 0;
  for (let i = 0; i < maxEvents; i++) {
    const client = await sourcePool.connect();
    let started = false, found = false;
    try {
      await client.query("BEGIN");
      started = true;
      const sender = await client.query(
        "SELECT id FROM whatsapp_sender_accounts WHERE sender_key='coexistence_qa' " +
        "AND meta_account_id=$1 AND meta_phone_number_id=$2 " +
        "AND state='testing' AND coexistence_enabled=TRUE FOR UPDATE",
        [source.waba, source.phoneId]
      );
      if (sender.rows?.length !== 1) throw Error("Captured sender is no longer verified");
      const result = await client.query(
        "SELECT fingerprint,sender_id,event_field,ciphertext,nonce,auth_tag,payload_bytes " +
        "FROM whatsapp_secondary_qa_capture_events " +
        "WHERE sender_id=$1 AND event_field IN ('history','smb_app_state_sync') " +
        "AND handoff_completed_at IS NULL AND expires_at>NOW() " +
        "ORDER BY received_at,fingerprint LIMIT 1 FOR UPDATE SKIP LOCKED",
        [sender.rows[0].id]
      );
      const row = result.rows?.[0];
      if (row) {
        found = true;
        if (row.sender_id !== sender.rows[0].id)
          throw Error("Encrypted capture sender mismatch");
        const parsed = decryptCapturedRow(row, source);
        const body = {object: "whatsapp_business_account", entry: [{
          id: source.waba, changes: [parsed.change]
        }]};
        const queued = await stage(body, {database: targetDatabase, env: importEnv});
        if (queued?.enabled !== true)
          throw Error("Inbox importer declined the captured history");
        await assertStagedJobs(targetDatabase, importEnv, parsed.change);
        const marked = await client.query(
          "UPDATE whatsapp_secondary_qa_capture_events " +
          "SET handoff_completed_at=NOW() " +
          "WHERE fingerprint=$1 AND sender_id=$2 AND handoff_completed_at IS NULL",
          [row.fingerprint, sender.rows[0].id]
        );
        if (marked.rowCount !== 1)
          throw Error("Encrypted capture handoff checkpoint failed");
      }
      await client.query("COMMIT");
      started = false;
      if (!found) break;
      transferred++;
    } catch (error) {
      if (started) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  // Explicit operator-controlled pass. Re-running this works even when no
  // new encrypted captures remain, so failed/pending Inbox imports can resume.
  const importer = processInboxJobs
    ? await importJobs({database:targetDatabase, env:importEnv, maxJobs:3})
    : null;
  return {transferred, importer, noCustomerMessagesSent:true};
}
module.exports = {configForHandoff, decryptCapturedRow, assertStagedJobs, handoffOnce};
