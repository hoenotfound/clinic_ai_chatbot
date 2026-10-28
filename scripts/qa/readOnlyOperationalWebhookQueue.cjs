"use strict";
// Read-only operator triage of Meta app-default notifications in isolated QA.
// No Meta API writes, no customer payloads, no external alerts or production SQL.
const { Pool } = require("pg");

const FIELDS = Object.freeze([
  "account_alerts", "account_review_update", "calls",
  "message_template_quality_update", "message_template_status_update",
  "phone_number_name_update", "phone_number_quality_update", "security"
]);
const SEVERITY = Object.freeze({
  security: "urgent", account_alerts: "urgent",
  account_review_update: "high", phone_number_quality_update: "high",
  message_template_status_update: "high",
  message_template_quality_update: "high",
  phone_number_name_update: "review", calls: "review"
});
const ACTION = Object.freeze({
  security: "Review the Meta security notice and account access in Meta Business Manager.",
  account_alerts: "Review the affected account in WhatsApp Manager.",
  account_review_update: "Review business account status in Meta Business Manager.",
  phone_number_quality_update: "Check phone quality and messaging limits in WhatsApp Manager.",
  message_template_status_update: "Verify actual template approval before using it.",
  message_template_quality_update: "Check template quality and campaign eligibility.",
  phone_number_name_update: "Check display-name approval and sender identity.",
  calls: "Review the calls event and supported calling configuration; do not infer a customer chat."
});

function configFromEnv(env=process.env) {
  const qaUri = String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL || "");
  const productionUri = String(env.DATABASE_URL || "");
  const pinnedHost = String(env.WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST || "")
    .trim().toLowerCase();
  const primaryAccount = String(env.WHATSAPP_WABA_ID || "");
  if (!/^\d{1,32}$/.test(primaryAccount)) throw Error("Pinned Neutro account ID required");
  let qa, production;
  try {
    qa = new URL(qaUri);
    production = new URL(productionUri);
  } catch (_) { throw Error("Production/QA database separation not configured"); }
  if (!["postgres:", "postgresql:"].includes(qa.protocol) ||
      !["postgres:", "postgresql:"].includes(production.protocol) ||
      !qa.username || !qa.password || !qa.hostname ||
      !pinnedHost.endsWith(".neon.tech") ||
      qa.hostname.toLowerCase() !== pinnedHost ||
      qa.hostname.toLowerCase() === production.hostname.toLowerCase() ||
      qaUri === productionUri) {
    throw Error("Refusing to read notifications without independently pinned QA Neon");
  }
  return Object.freeze({
    connectionString: qaUri, accountId: primaryAccount,
    // This is a separate SQL-only operator process, not the production pool.
    maxLookbackHours: 168
  });
}

function summarize(rows=[]) {
  const allowed = new Set(FIELDS);
  const sorted = [];
  for (const row of rows) {
    if (!allowed.has(row.event_field) ||
        typeof row.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.fingerprint)) {
      throw Error("Invalid or unexpected QA notification audit result");
    }
    const when = new Date(row.first_seen_at);
    if (!Number.isFinite(when.getTime())) throw Error("Invalid audit timestamp");
    sorted.push({
      field: row.event_field,
      severity: SEVERITY[row.event_field],
      firstSeen: when.toISOString(),
      fingerprint: row.fingerprint,
      action: ACTION[row.event_field],
      requiresManualReview: true
    });
  }
  const rank={urgent:0,high:1,review:2};
  return sorted.sort((a,b)=>rank[a.severity]-rank[b.severity] ||
    a.firstSeen.localeCompare(b.firstSeen));
}

async function inspect({
  env=process.env,database=null,lookbackHours=24,limit=100
}={}) {
  if (!Number.isInteger(lookbackHours) || lookbackHours < 1 ||
      lookbackHours > 168 || !Number.isInteger(limit) ||
      limit < 1 || limit > 100) throw Error("Invalid bounded audit query");
  const cfg = configFromEnv(env);
  const pool = database || new Pool({
    connectionString:cfg.connectionString,
    ssl:{rejectUnauthorized:true},
    max:1,connectionTimeoutMillis:3000,idleTimeoutMillis:1000,
    statement_timeout:4000,query_timeout:5000,
    application_name:"da-chatbot-qa-notification-review"
  });
  try {
    const result = await pool.query(
      "SELECT fingerprint,event_field,first_seen_at FROM " +
      "whatsapp_sender_quarantined_events " +
      "WHERE meta_account_id=$1 " +
      "AND reason='unsupported_whatsapp_event' " +
      "AND event_field = ANY($2::text[]) " +
      "AND first_seen_at >= NOW()-($3::integer*INTERVAL '1 hour') " +
      "ORDER BY first_seen_at DESC, fingerprint DESC LIMIT $4",
      [cfg.accountId,FIELDS,lookbackHours,limit]
    );
    return {
      readOnly:true,source:"isolated-QA-only",accountId:cfg.accountId,
      lookbackHours,returned:result.rows.length,
      possiblyTruncated:result.rows.length===limit,
      // No acknowledgement state is present. Repeated items remain for review.
      notifications:summarize(result.rows)
    };
  } finally {
    if (!database) await pool.end();
  }
}
if(require.main===module) {
  inspect().then(result=>{
    console.log(JSON.stringify(result,null,2));
    if(result.notifications.some(n=>n.severity==="urgent")) process.exitCode=3;
  }).catch(()=>{
    // Do not print exception details: a database driver can embed connection
    // information, including credentials, in errors.
    console.error("Isolated QA notification audit unavailable; no readiness claim.");
    process.exitCode=2;
  });
}
module.exports={FIELDS,SEVERITY,ACTION,configFromEnv,summarize,inspect};
