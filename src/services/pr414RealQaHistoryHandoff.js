"use strict";

// Staging-only, operator-controlled import of already captured Meta history.
// Never requests a sync, sends a message, calls Meta, or changes production.
const capture = require("./whatsappSecondaryQaCapture");
const ingress = require("./whatsappPaidDefaultIngress");
const handoff = require("./whatsappSecondaryCaptureHandoff");
const history = require("./whatsappCoexistenceHistoryService");
const {pool: target} = require("../db/db");
const {Pool} = require("pg");

const NEVER_SEND = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED",
  "WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_MEDIA_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED",
  "WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED",
  "WHATSAPP_FEP_FOLLOWUPS_ENABLED"
];

function assertOperatorIsolation(env, action) {
  // Nonsecret gate diagnostics only. Never log tokens, credentials, phones or payloads.
  const gates = {
    action: ["inspect","import"].includes(action),
    staging: env.PR395_STAGING_MODE === "true",
    operator: env.PR414_QA_REAL_HISTORY_OPERATOR_APPROVED === "true",
    noSynthetic: env.PR414_QA_SYNTHETIC_REHEARSAL_ON_BOOT !== "true",
    noProvider: env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true",
    noSyncDispatch: env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED !== "true",
    noSender: !NEVER_SEND.some(key => env[key] === "true"),
    sameHostQa: env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ALLOW_SAME_QA_HOST === "true",
    sourcePin: env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE === "neondb",
    targetPin: env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE === "pr414_forward_qa",
    handoffEnabled: action !== "import" || env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED === "true",
    handoffApproved: action !== "import" || env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED === "true"
  };
  const missing = Object.keys(gates).filter(key => !gates[key]);
  if (missing.length) console.error("[PR414 real QA] blocked nonsecret gate names: " + missing.join(","));
  if (!["inspect", "import"].includes(action) ||
      env.PR395_STAGING_MODE !== "true" ||
      env.PR414_QA_REAL_HISTORY_OPERATOR_APPROVED !== "true" ||
      env.PR414_QA_SYNTHETIC_REHEARSAL_ON_BOOT === "true" ||
      env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING === "true" ||
      env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED === "true" ||
      NEVER_SEND.some(key => env[key] === "true") ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ALLOW_SAME_QA_HOST !== "true" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_SOURCE_DATABASE !== "neondb" ||
      env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_DATABASE !== "pr414_forward_qa" ||
      (action === "import" &&
       (env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED !== "true" ||
        env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_OPERATOR_APPROVED !== "true"))) {
    throw Error("Real QA history operator refused: independent staging, consent, or zero-send guards missing");
  }
  let src, dst;
  try {
    src = new URL(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL);
    dst = new URL(env.DATABASE_URL);
  } catch (_) { throw Error("Real QA history operator needs separate database URLs"); }
  if (src.protocol !== "postgresql:" && src.protocol !== "postgres:" ||
      dst.protocol !== "postgresql:" && dst.protocol !== "postgres:" ||
      src.hostname !== dst.hostname || !src.hostname.endsWith(".neon.tech") ||
      src.hostname !== env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST ||
      dst.hostname !== env.WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_TARGET_HOST ||
      decodeURIComponent(src.pathname) !== "/neondb" ||
      decodeURIComponent(dst.pathname) !== "/pr414_forward_qa" ||
      src.username !== "pr395_staging_owner" ||
      dst.username !== "pr414_forward_qa_owner" ||
      !src.password || !dst.password || src.password === dst.password) {
    throw Error("Real QA history operator refused: incorrect QA database isolation");
  }
  return {qaDatabaseUrl:env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL};
}

function summarize(rows, source) {
  const phases = new Map();
  let complete = false, declined = false, otherErrors = 0;
  let chunks = 0, messages = 0, threads = 0;
  for (const row of rows) {
    if (row.event_field !== "history") continue;
    const envelope = handoff.decryptCapturedRow(row, source);
    const value = envelope.change.value || {};
    const parts = Array.isArray(value.history) ? value.history : [];
    for (const part of parts) {
      chunks++;
      const meta = part.metadata || {};
      const phase = Number(meta.phase ?? part.phase);
      const progress = Number(meta.progress ?? part.progress);
      const label = Number.isInteger(phase) && phase >= 0 && phase <= 2 ? String(phase) : "unknown";
      const old = phases.get(label) || {chunks:0, maxProgress:null};
      old.chunks++;
      if (Number.isFinite(progress) && progress >= 0 && progress <= 100) {
        old.maxProgress = Math.max(old.maxProgress ?? 0, progress);
        if (progress === 100) complete = true;
      }
      phases.set(label, old);
      const list = Array.isArray(part.threads) ? part.threads : [];
      threads += list.length;
      for (const thread of list)
        messages += Array.isArray(thread.messages) ? thread.messages.length : 0;
      const errors = Array.isArray(part.errors) ? part.errors : [];
      declined ||= errors.some(err => Number(err.code) === 2593109);
      otherErrors += errors.filter(err => Number(err.code) !== 2593109).length;
    }
    const errors = Array.isArray(value.errors) ? value.errors : [];
    declined ||= errors.some(err => Number(err.code) === 2593109);
    otherErrors += errors.filter(err => Number(err.code) !== 2593109).length;
  }
  return {
    historyCaptures: rows.filter(r => r.event_field === "history").length,
    contactSyncCaptures: rows.filter(r => r.event_field === "smb_app_state_sync").length,
    handedOff: rows.filter(r => r.handoff_completed_at != null).length,
    chunks, threadOccurrences: threads, messageOccurrences: messages,
    phases: Object.fromEntries([...phases.entries()].sort()),
    complete, declined, otherErrors
  };
}

async function one(db, sql, values=[]) {
  const r = await db.query(sql, values);
  return r.rows?.[0];
}

async function runOnBoot(env=process.env) {
  const action = String(env.PR414_QA_REAL_HISTORY_ACTION || "");
  if (!action) return;
  const base = assertOperatorIsolation(env, action);
  const source = new Pool({
    connectionString:base.qaDatabaseUrl,
    ssl:{rejectUnauthorized:false},max:2,
    connectionTimeoutMillis:5000,idleTimeoutMillis:10000,
    statement_timeout:15000,query_timeout:20000,
    application_name:"pr414-consented-qa-history-one-shot"
  });
  const [sourceSchema, targetSchema, sourceSender, targetSender, captures, onboarding, consents] = await Promise.all([
    one(source, "SELECT max(version)::int AS version FROM schema_migrations"),
    one(target, "SELECT max(version)::int AS version FROM schema_migrations"),
    source.query("SELECT id,meta_account_id,meta_phone_number_id FROM whatsapp_sender_accounts WHERE sender_key='coexistence_qa' AND state='testing' AND coexistence_enabled=TRUE"),
    target.query("SELECT id,meta_account_id,meta_phone_number_id FROM whatsapp_sender_accounts WHERE sender_key='coexistence_qa' AND state='active' AND coexistence_enabled=TRUE"),
    source.query("SELECT fingerprint,sender_id,event_field,ciphertext,nonce,auth_tag,payload_bytes,received_at,expires_at,handoff_completed_at FROM whatsapp_secondary_qa_capture_events WHERE event_field IN ('history','smb_app_state_sync') ORDER BY received_at,fingerprint LIMIT 501"),
    target.query("SELECT waba_id,phone_number_id,display_phone_number,status,coexistence_ready FROM whatsapp_coexistence_onboarding_attempts ORDER BY created_at DESC LIMIT 2"),
    target.query("SELECT sync_type,state,consent_granted FROM whatsapp_coexistence_sync_dispatch_requests ORDER BY updated_at DESC LIMIT 4")
  ]);
  if (sourceSchema?.version !== 104 || targetSchema?.version !== 106 ||
      sourceSender.rows?.length !== 1 || targetSender.rows?.length !== 1 ||
      captures.rows?.length >= 501 || !captures.rows?.length ||
      captures.rows.some(r => String(r.sender_id) !== String(sourceSender.rows[0].id))) {
    throw Error("Real QA history refused: schema, verified sender, or capture row count mismatch");
  }
  const claimed = sourceSender.rows[0];
  const destination = targetSender.rows[0];
  const onboarded = onboarding.rows?.[0];
  const digits = s => String(s || "").replace(/\D/g, "");
  if (onboarding.rows.length !== 1 || !onboarded ||
      onboarded.status !== "validated" || onboarded.coexistence_ready !== true ||
      !onboarded.waba_id || !onboarded.phone_number_id ||
      claimed.meta_account_id !== onboarded.waba_id ||
      destination.meta_account_id !== onboarded.waba_id ||
      claimed.meta_phone_number_id !== onboarded.phone_number_id ||
      destination.meta_phone_number_id !== onboarded.phone_number_id ||
      !/^60\d{9,12}$/.test(digits(onboarded.display_phone_number)) ||
      consents.rows.length !== 2 ||
      !["history","smb_app_state_sync"].every(type => consents.rows.some(
        row => row.sync_type === type && row.state === "accepted" &&
          row.consent_granted === true))) {
    throw Error("Real QA history refused: onboarded testing number or durable opt-in mismatch");
  }
  // In-memory approvals are backed by the already-accepted, consented QA
  // records above. Do not alter global capture, Meta, or outbound switches.
  const onboardedE164 = "+" + digits(onboarded.display_phone_number);
  const operatorEnv = {
    ...env,
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:onboardedE164,
    // These placeholders are ONLY passed to local config validators.
    // No HTTP endpoint, Meta request or process.env receives them.
    WHATSAPP_APP_SECRET:"pr414-no-meta-network-local-validation-secret",
    META_APP_SECRET:"pr414-no-meta-network-local-validation-secret",
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"pr414-no-meta-network-local-verification",
    WHATSAPP_WABA_ID:"910000000000001",
    WHATSAPP_PHONE_NUMBER_ID:"910000000000002",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+60129999901",
    WHATSAPP_PHONE_NUMBER:"+60129999901",
    WHATSAPP_SECONDARY_WABA_ID:"",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
    WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
    WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:onboardedE164,
    WHATSAPP_PAID_SECONDARY_QA_WABA_ID:claimed.meta_account_id,
    WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:claimed.meta_phone_number_id
  };
  const config = capture.captureConfig(operatorEnv);
  const report = summarize(captures.rows, config);
  const expired = captures.rows.filter(r => new Date(r.expires_at).getTime() <= Date.now()).length;
  const stats = { ...report, expired, action };
  console.log("[PR414 real QA] completion metadata only: " + JSON.stringify(stats));
  if (action === "inspect") return stats;
  if (!report.complete || report.declined || report.otherErrors > 0 || expired) {
    throw Error("Real QA history NOT imported: terminal progress 100 or consent/error/retention gate not satisfied");
  }
  const pending = captures.rows.filter(r => r.handoff_completed_at == null).length;
  const maxPasses = Math.ceil(pending / 3) + 1;
  let transferred = 0;
  for (let i=0; i<maxPasses; i++) {
    const r = await handoff.handoffOnce({
      env: operatorEnv, sourceDatabase: source, targetDatabase: target,
      maxEvents: 3, processInboxJobs: false
    });
    transferred += r.transferred;
    if (r.transferred === 0) break;
  }
  // Explicit bounded importer, without enabling the 60s background worker.
  const {importEnv} = handoff.configForHandoff(operatorEnv);
  let processed = 0, failureSignals = 0;
  for (let i=0; i<180; i++) {
    const due = await one(target,
      "SELECT count(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs WHERE sender_id=$1 AND status='pending' AND next_attempt_at<=NOW()",
      [targetSender.rows[0].id]);
    if (!due?.n) break;
    const r = await history.runOnce({database:target,env:importEnv,maxJobs:3});
    if (r.disabled) throw Error("Real QA Inbox importer unexpectedly disabled");
    processed += r.processed;
    failureSignals += r.failed;
    if (r.processed === 0) break; // avoid repeated failed retries
  }
  const state = await target.query(
    "SELECT status,count(*)::int AS n FROM whatsapp_sender_coexistence_import_jobs WHERE sender_id=$1 GROUP BY status ORDER BY status",
    [targetSender.rows[0].id]
  );
  const counts = await one(target,
    "SELECT (SELECT count(*)::int FROM whatsapp_sender_coexistence_history_messages WHERE sender_id=$1) AS imported_history_messages, (SELECT count(*)::int FROM contacts WHERE whatsapp_sender_id=$1) AS sender_contacts",
    [targetSender.rows[0].id]);
  const outcome = {transferred, processed, failureSignals, jobs:state.rows,
    importedHistoryMessages:counts?.imported_history_messages,
    senderContacts:counts?.sender_contacts, noMetaOrOutboundCalls:true};
  console.log("[PR414 real QA] import counts only: " + JSON.stringify(outcome));
  if (state.rows.some(r => r.status !== "completed") ||
      Number(outcome.importedHistoryMessages) < 1) {
    throw Error("Real QA history requires review: some imported jobs are not completed");
  }
  return outcome;
}

module.exports={assertOperatorIsolation,summarize,runOnBoot};
