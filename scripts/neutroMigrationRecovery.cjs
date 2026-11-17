#!/usr/bin/env node
"use strict";

// Source-only recovery helper. This is NOT a cutover controller or a timer.
// Run on an independent trusted runner, never in the chatbot container.
const { SOURCE_HOST, connectionIdentity } = require("./neutroMigrationHold.cjs");
const SERVICE = "srv-daqd1rp42hec7398itr0";
const WORKSPACE = "tea-d4b8qt0dl3ps73988f70";
const COMMIT = "ac3f8b281b9f3643504c9a9214af931f7a080a35";
const HOLD = "NEUTRO_MIGRATION_HOLD=20261116 node scripts/neutroMigrationHold.cjs";
const ROOT = "https://neutrosense.dasmarketingsolution.com/";
const TERMINAL = new Set(["live", "deactivated", "build_failed", "update_failed", "pre_deploy_failed", "canceled"]);
const unwrap = value => value?.deploy || value;

function api(key, fetchImpl = global.fetch) {
  if (!key) throw Error("RENDER_API_KEY is missing; configure it privately on the independent runner.");
  return async (path, method = "GET", body) => {
    let response;
    try {
      response = await fetchImpl(`https://api.render.com/v1/services/${SERVICE}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (_) { throw Error(`Render ${method} request failed; inspect state before retrying a mutation.`); }
    if (!response.ok) throw Error(`Render ${method} returned HTTP ${response.status}; response body withheld.`);
    try { return await response.json(); }
    catch (_) { throw Error("Render returned an invalid response; inspect state before retrying."); }
  };
}

function validate(service, rawUrl, entries, expectedDeploy, requireHold) {
  const details = service?.serviceDetails;
  const command = details?.envSpecificDetails?.startCommand;
  const db = connectionIdentity(rawUrl);
  if (service.id !== SERVICE || service.ownerId !== WORKSPACE || service.type !== "web_service" ||
      service.repo !== "https://github.com/hoenotfound/clinic_ai_chatbot" ||
      details?.env !== "node" || details?.numInstances !== 1 || service.suspended !== "not_suspended" ||
      details?.maintenanceMode?.enabled !== false ||
      !(service.autoDeployTrigger === "off" || (service.autoDeployTrigger == null && service.autoDeploy === "no")))
    throw Error("Unexpected service configuration; recovery blocked.");
  if (db.host !== SOURCE_HOST || db.database !== "/neondb")
    throw Error("Database is not the original source; source recovery is forbidden.");
  if (![HOLD, "npm start"].includes(command)) throw Error("Unrecognized start command.");
  if (!Array.isArray(entries) || entries.length === 0) throw Error("Deployment history unavailable.");
  const deploys = entries.map(unwrap);
  // Unknown statuses are treated as active, not assumed safe.
  if (deploys.some(d => !TERMINAL.has(d.status))) throw Error("An active or unknown deployment blocks recovery.");
  const live = deploys.filter(d => d.status === "live");
  if (live.length !== 1 || live[0].commit?.id !== COMMIT) throw Error("Live code differs from the reviewed recovery version.");
  if (expectedDeploy && live[0].id !== expectedDeploy) throw Error("Live deployment changed; recovery blocked.");
  if (requireHold && command !== HOLD) throw Error("Expected standalone holding start command.");
  return { service: SERVICE, sourceDatabase: true, commit: COMMIT, liveDeploy: live[0].id, startCommand: command };
}

async function inspect(request, expectedDeploy, requireHold = false) {
  const [service, env, deploys] = await Promise.all([
    request(""), request("/env-vars/DATABASE_URL"), request("/deploys?limit=100"),
  ]);
  return validate(service, (env.envVar || env).value, deploys, expectedDeploy, requireHold);
}

async function probe(fetchImpl, holding, allowDrainedApplication = false) {
  const r = await fetchImpl(ROOT, { redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache" } });
  if (r.status !== 200) throw Error("Public health check failed.");
  const body = await r.text();
  let data;
  try { data = JSON.parse(body); } catch (_) { /* Normal root returns a fixed readiness message. */ }
  const isHold = data?.mode === "migration_hold" && data.chatbotRunning === false;
  const drainedApp = data?.mode === "migration_hold" && data.acceptingWork === false &&
    data.activeTasks === 0 && data.drained === true;
  const paused = data?.mode === "migration_hold" || data?.mode === "migration_draining" || data?.acceptingWork === false;
  if (holding ? !(isHold || (allowDrainedApplication && drainedApp)) : paused)
    throw Error("Public holding state does not match the expected phase.");
  if (!holding && body.trim() !== "AI messaging bot is running.")
    throw Error("Normal application readiness response was not observed.");
}

async function verifyRecoveredSource({ request, expectedDeploy, emit, fetchImpl = global.fetch,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const deadline = now() + 60000;
  emit({ phase: "source_verification_started", deployId: expectedDeploy });
  async function checkIdentity() {
    try {
      const state = await inspect(request, expectedDeploy);
      if (state.startCommand !== "npm start") throw Error("Unexpected source command.");
    } catch (_) {
      emit({ phase: "source_verification_failed", reason: "source_identity_or_configuration" });
      throw Error("Source verification identity or configuration check failed.");
    }
  }
  while (true) {
    // Identity/configuration failures stop immediately. Only public readiness
    // observations may be retried; this function never writes or redeploys.
    await checkIdentity();
    let ready = false;
    try {
      await probe(fetchImpl, false);
      ready = true;
    } catch (_) {
      if (now() >= deadline) {
        emit({ phase: "source_verification_failed", reason: "public_readiness_deadline" });
        throw Error("Source public readiness verification deadline exceeded.");
      }
      emit({ phase: "source_readiness_wait", deployId: expectedDeploy });
      await wait(2000);
    }
    if (ready) {
      await checkIdentity();
      emit({ phase: "source_readiness_verified", deployId: expectedDeploy });
      return;
    }
  }
}

async function recover({ request, expectedDeploy, approved, emit, fetchImpl = global.fetch,
  now = Date.now, wait = ms => new Promise(r => setTimeout(r, ms)), allowDrainedApplication = false }) {
  if (approved !== "source-only-before-any-destination-writes" || !/^dep-[a-z0-9]+$/.test(expectedDeploy || ""))
    throw Error("Explicit source-only recovery approval and holding deployment ID required.");
  await inspect(request, expectedDeploy, !allowDrainedApplication);
  await probe(fetchImpl, true, allowDrainedApplication);
  // Recheck immediately before the first write. Render has no atomic compare-
  // and-swap across config and deploy APIs. Exclusive operator control is required.
  await inspect(request, expectedDeploy, !allowDrainedApplication);
  emit({ phase: "before_start_command_change", expectedDeploy, commit: COMMIT });
  await request("", "PATCH", { serviceDetails: { envSpecificDetails: { startCommand: "npm start" } } });
  const checked = await inspect(request, expectedDeploy);
  if (checked.startCommand !== "npm start") throw Error("Normal start command was not saved.");
  emit({ phase: "before_deploy_request", expectedDeploy, commit: COMMIT });
  // Never automatically retry this POST: a lost response may still mean accepted.
  const deployment = unwrap(await request("/deploys", "POST", { commitId: COMMIT, clearCache: "do_not_clear" }));
  if (!/^dep-[a-z0-9]+$/.test(deployment?.id || "")) throw Error("No deployment ID returned; inspect Render before retrying.");
  emit({ phase: "deploy_requested", deployId: deployment.id, commit: COMMIT });
  const deadline = now() + 15 * 60 * 1000;
  while (now() < deadline) {
    const d = unwrap(await request(`/deploys/${deployment.id}`));
    if (d.commit?.id !== COMMIT) throw Error("Unexpected recovery deployment commit.");
    if (d.status === "live") {
      await verifyRecoveredSource({ request, expectedDeploy: deployment.id, emit, fetchImpl, now, wait });
      emit({ phase: "source_deploy_live", deployId: d.id, commit: COMMIT, customerDeliveryVerified: false });
      return;
    }
    if (TERMINAL.has(d.status)) throw Error("Recovery deployment ended without becoming live.");
    await wait(5000);
  }
  throw Error("Recovery monitoring deadline reached; inspect the recorded deployment, do not blindly redeploy.");
}

async function verifySource(options) {
  const state = await inspect(options.request);
  await verifyRecoveredSource({ ...options, expectedDeploy: state.liveDeploy });
  options.emit({ phase: "read_only_source_verified", ...state, cutoverReady: false, customerDeliveryVerified: false });
}

async function main() {
  const mode = process.argv[2] || "--check";
  if (!["--check", "--verify-source", "--recover-source"].includes(mode)) throw Error("Use --check, --verify-source or --recover-source.");
  if (process.env.RENDER_SERVICE_ID) throw Error("Run recovery outside the production Render service.");
  const request = api(process.env.RENDER_API_KEY);
  const emit = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
  if (mode === "--check") {
    emit({ phase: "read_only_check", ...(await inspect(request)), cutoverReady: false });
  } else if (mode === "--verify-source") {
    await verifySource({ request, emit });
  } else {
    await recover({ request, expectedDeploy: process.env.NEUTRO_EXPECTED_HOLD_DEPLOY,
      approved: process.env.NEUTRO_SOURCE_RECOVERY_APPROVED, emit });
  }
}
if (require.main === module) main().catch(error => {
  // Avoid echoing provider bodies, URLs, keys or customer payloads.
  console.error("RECOVERY_STOPPED: " + (error.message.startsWith("Render ") ||
    /^[A-Za-z0-9 .,;:_/?-]+$/.test(error.message) ? error.message : "Check private runner diagnostics."));
  process.exitCode = 1;
});
module.exports = { SERVICE, WORKSPACE, COMMIT, HOLD, api, validate, inspect, probe, recover, verifyRecoveredSource, verifySource };
