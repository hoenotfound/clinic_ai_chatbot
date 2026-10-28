"use strict";

// Internal operator-only service. Never attach to an HTTP route, webhook,
// automated startup worker or onboarding completion callback.
const { pool } = require("../db/db");
const { loadValidatedCredentialForSetup } =
  require("../db/whatsappCoexistenceOnboardingRepo");
const { normalizedGraphVersion, DEFAULT_GRAPH_API_VERSION } =
  require("../provisioning/whatsappWebhookSubscription");

const { clinicSecondNumberApproved } = require("./pr395StagingSafety");
const TYPES = new Set(["smb_app_state_sync", "history"]);
const SEND_SWITCHES = [
  "WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED",
  "WHATSAPP_SECONDARY_STAFF_SEND_ENABLED",
  "WHATSAPP_SECONDARY_AI_SEND_ENABLED",
  "WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED"
];
function digits(s) { return /^\d+$/.test(String(s || "")) ? String(s) : null; }
function assertSafeCommand(input, env, now) {
  if (env.PR395_STAGING_MODE !== "true" ||
      env.PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED !== "true" ||
      env.PR395_STAGING_ALLOW_PROVIDER_PROCESSING !== "true" ||
      SEND_SWITCHES.some(name => env[name] === "true")) {
    throw Error("One-time sync requires separately authorized isolated QA, provider receiver and zero outbound sends.");
  }
  if (input.operatorApproved !== true || input.receiverReady !== true ||
      input.importerReady !== true || input.verifiedAppSubscription !== true ||
      input.verifiedCallbackOverride !== true) {
    throw Error("Explicit operator approval and live signed receiver/importer proof required.");
  }
  if (!TYPES.has(input.syncType) || !digits(input.wabaId) ||
      !digits(input.phoneNumberId) || !Number.isSafeInteger(input.onboardingAttemptId) ||
      input.onboardingAttemptId < 1 ||
      String(input.wabaId) !== String(env.WHATSAPP_SECONDARY_WABA_ID || "") ||
      String(input.phoneNumberId) !== String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID || "") ||
      String(input.wabaId) === String(env.WHATSAPP_WABA_ID || "") ||
      String(input.phoneNumberId) === String(env.WHATSAPP_PHONE_NUMBER_ID || "")) {
    throw Error("Only the exact pinned, authorized secondary WABA/phone/attempt is eligible.");
  }
  if (String(env.WHATSAPP_SECONDARY_EXPECTED_PHONE_E164 || "") !==
      String(env.PR395_STAGING_APPROVED_TEST_PHONE_E164 || "") ||
      !/^\+[1-9]\d{7,14}$/.test(String(env.PR395_STAGING_APPROVED_TEST_PHONE_E164 || "")) ||
      (env.PR395_STAGING_APPROVED_TEST_PHONE_E164 === "+60174831336" &&
        !clinicSecondNumberApproved(env))) {
    throw Error("QA E164 pin is missing, mismatched or is the excluded clinic number.");
  }
  // Both contacts and history require verified owner consent. History has
  // an additional explicit opt-in; neither flag can be inferred from a QR.
  if (input.syncConsent !== true ||
      (input.syncType === "history" && input.historyConsent !== true) ||
      !["embedded_signup_owner","operator_verified"].includes(input.consentSource) ||
      !/^[a-zA-Z0-9 _@.-]{3,128}$/.test(String(input.consentVerifiedBy || ""))) {
    throw Error("Verified data-sharing consent and consent provenance are required.");
  }
  const completed = new Date(input.onboardingCompletedAt);
  const clock = new Date(now);
  if (!Number.isFinite(completed.getTime()) || !Number.isFinite(clock.getTime()) ||
      completed.getTime() > clock.getTime() ||
      clock.getTime() - completed.getTime() >= 24 * 3600000) {
    throw Error("Meta one-time sync window is expired or unverified.");
  }
  return completed;
}
async function reserveOnce(input, { database = pool, env = process.env, now = new Date() } = {}) {
  const completed = assertSafeCommand(input, env, now);
  const approvedAt = new Date(now).toISOString();
  const result = await database.query(
    "INSERT INTO whatsapp_coexistence_sync_dispatch_requests " +
    "(onboarding_attempt_id,waba_id,phone_number_id,sync_type,onboarding_completed_at," +
    "consent_granted,consent_source,consent_verified_by,approved_at) " +
    "SELECT a.id,a.waba_id,a.phone_number_id,$4,$5,TRUE,$6,$7,$8 " +
    "FROM whatsapp_coexistence_onboarding_attempts a " +
    "JOIN whatsapp_coexistence_onboarding_credentials c ON c.attempt_id=a.id " +
    "AND c.waba_id=a.waba_id AND c.phone_number_id=a.phone_number_id " +
    "WHERE a.id=$1 AND a.waba_id=$2 AND a.phone_number_id=$3 " +
    "AND a.status='validated' AND c.token_expires_at>$8::timestamptz " +
    "AND a.created_at >= $5::timestamptz " +
    "ON CONFLICT(waba_id,phone_number_id,sync_type) DO NOTHING RETURNING id,state",
    [input.onboardingAttemptId,input.wabaId,input.phoneNumberId,
      input.syncType,completed.toISOString(),input.consentSource,
      input.consentVerifiedBy,approvedAt]
  );
  if (result.rows?.length !== 1) {
    throw Error("No validated onboarding/credential or this sync type was already reserved; never retry blindly.");
  }
  return result.rows[0];
}

async function dispatchOnce(input, {
  database = pool, env = process.env, now = new Date(),
  fetchImpl = global.fetch, loadCredential = loadValidatedCredentialForSetup,
} = {}) {
  // Read credential before consuming the once-only claim; token is never
  // returned or persisted in the dispatcher table.
  assertSafeCommand(input,env,now);
  const credential = await loadCredential({
    wabaId: input.wabaId,phoneNumberId:input.phoneNumberId
  }, {database,env,now});
  if (!credential?.accessToken || credential.wabaId !== input.wabaId ||
      credential.phoneNumberId !== input.phoneNumberId) {
    throw Error("Verified secondary token not available.");
  }
  const reserved = await reserveOnce(input,{database,env,now});
  const claimed = await database.query(
    "UPDATE whatsapp_coexistence_sync_dispatch_requests " +
    "SET state='dispatching',request_started_at=NOW(),updated_at=NOW() " +
    "WHERE id=$1 AND state='reserved' RETURNING id",
    [reserved.id]
  );
  if (claimed.rows?.length !== 1) throw Error("One-time dispatch claim was lost; do not POST.");
  let state = "unknown", status = null, errorCode = null, providerRequestId = null;
  try {
    const url = "https://graph.facebook.com/" +
      normalizedGraphVersion(env.META_GRAPH_API_VERSION || DEFAULT_GRAPH_API_VERSION) +
      "/" + input.phoneNumberId + "/smb_app_data";
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + credential.accessToken,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product:"whatsapp",sync_type:input.syncType
      }),
      signal: AbortSignal.timeout(10000)
    });
    status = Number.isInteger(response?.status) ? response.status : null;
    const data = await response.json().catch(() => null);
    // Meta typically returns a request_id for this endpoint, not a success flag.
    // Never mark an unrecognized HTTP 2xx response confirmed.
    const requestId = typeof data?.request_id === "string" ? data.request_id.trim() : "";
    if (response.ok === true && data?.messaging_product === "whatsapp" &&
        requestId.length > 0 && requestId.length <= 512) {
      state = "accepted"; providerRequestId = requestId;
    } else if (response.ok === true && data?.success === true) state = "accepted";
    else if (response.ok === false && status >= 400 && status < 500 &&
             status !== 408 && status !== 429) {
      state = "rejected"; errorCode = "definitive_provider_rejection";
    } else {
      errorCode = "ambiguous_provider_response";
    }
  } catch (_) {
    // This includes network timeouts AFTER Meta may have accepted the POST.
    // Never automatically retry even for an apparently failed request.
    errorCode = "uncertain_network_outcome";
  }
  try {
    const confirmed = await database.query(
      "UPDATE whatsapp_coexistence_sync_dispatch_requests " +
      "SET state=$2,http_status=$3,provider_error_code=$4,provider_request_id=$5," +
      "resolved_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='dispatching'",
      [reserved.id,state,status,errorCode,providerRequestId]
    );
    if (confirmed.rowCount !== 1) throw Error("Dispatch outcome row was not updated.");
  } catch (_) {
    // The durable 'dispatching' claim still prohibits a second POST.
    throw Error("Sync request outcome could not be persisted. Treat as UNKNOWN; do not retry.");
  }
  return { id:reserved.id,state,httpStatus:status,providerRequestId,requiresManualReview:state!=="accepted" };
}
async function quarantineStaleClaims({
  database=pool, olderThanMinutes=2
}={}) {
  if (!Number.isInteger(olderThanMinutes) || olderThanMinutes < 2) throw Error("Invalid review window");
  return database.query(
    "UPDATE whatsapp_coexistence_sync_dispatch_requests " +
    "SET state='unknown',provider_error_code='worker_interrupted'," +
    "resolved_at=NOW(),updated_at=NOW() " +
    "WHERE state='dispatching' AND request_started_at < NOW() - ($1::integer * INTERVAL '1 minute') " +
    "RETURNING id,waba_id,phone_number_id,sync_type",
    [olderThanMinutes]
  );
}
module.exports = { assertSafeCommand,reserveOnce,dispatchOnce,quarantineStaleClaims };
