#!/usr/bin/env node
"use strict";

// Independent, source-only rehearsal controller. No SQL, destination credentials,
// customer sends or database URL mutations. Never run during a database copy.
const fs = require("node:fs");
const { COMMIT, HOLD, api, inspect, recover } = require("./neutroMigrationRecovery.cjs");
const ROOT = "https://neutrosense.dasmarketingsolution.com/";
const APPROVAL = "source-only-rehearsal-no-copy-no-cutover";
const STOPPED = new Set(["deactivated", "build_failed", "update_failed", "pre_deploy_failed", "canceled"]);

async function runtime(fetchImpl = global.fetch) {
  const response = await fetchImpl(ROOT, { redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "Cache-Control": "no-cache" } });
  if (response.status !== 200) throw Error("Public runtime unavailable.");
  const body = await response.text();
  let state;
  try { state = JSON.parse(body); } catch (_) {
    if (body.trim() === "AI messaging bot is running.") return "running";
    throw Error("Unrecognized public runtime response.");
  }
  if (state.mode === "migration_hold" && state.chatbotRunning === false) return "standalone";
  if (state.mode === "migration_hold" && state.acceptingWork === false &&
      state.activeTasks === 0 && state.drained === true) return "drained";
  if (state.mode === "migration_draining" && state.acceptingWork === false &&
      Number.isInteger(state.activeTasks) && state.activeTasks >= 0 && state.drained === false) return "draining";
  throw Error("Unrecognized public runtime response.");
}

function journal(path, output = console.log) {
  const events = [];
  return event => {
    const record = { at: new Date().toISOString(), ...event };
    events.push(record);
    // Metadata only. Persist before a mutation, never include provider bodies.
    fs.writeFileSync(path + ".tmp", JSON.stringify(events), { mode: 0o600 });
    fs.renameSync(path + ".tmp", path);
    output(JSON.stringify(record));
  };
}

async function run({ request, approved, expectedDeploy, emit, readRuntime = runtime,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), fetchImpl = global.fetch }) {
  if (approved !== APPROVAL || !/^dep-[a-z0-9]+$/.test(expectedDeploy || ""))
    throw Error("Explicit source-only rehearsal approval and initial deployment ID required.");
  let current = await inspect(request, expectedDeploy);
  if (current.startCommand !== "npm start" || await readRuntime() !== "running")
    throw Error("Arm before any production pause, with the normal source application running.");
  // The operator may signal the already-deployed drain only after this record.
  // All following transitions are owned by this runner, not by the browser.
  const armDeadline = now() + 120000;
  emit({ phase: "armed", initialDeploy: expectedDeploy, armDeadline, noCopyOrCutover: true });
  let drainDeadline, consecutive = 0;
  while (true) {
    current = await inspect(request, expectedDeploy);
    if (current.startCommand !== "npm start") throw Error("Configuration changed while armed.");
    const state = await readRuntime();
    if (state === "standalone") throw Error("Unexpected external holding deployment.");
    if (state === "running") {
      if (drainDeadline) throw Error("Runtime resumed outside this controller.");
      if (now() >= armDeadline) { emit({ phase: "expired_without_pause" }); return; }
    } else {
      if (!drainDeadline) {
        drainDeadline = now() + 120000;
        emit({ phase: "drain_observed", drainDeadline });
      }
      if (now() >= drainDeadline) throw Error("Drain deadline exceeded; do not retire active or faulted work.");
      consecutive = state === "drained" ? consecutive + 1 : 0;
      if (consecutive >= 3) break;
    }
    await wait(2000);
  }
  await inspect(request, expectedDeploy);
  if (await readRuntime() !== "drained") throw Error("Drain readiness changed before retirement.");
  emit({ phase: "drain_verified", initialDeploy: expectedDeploy });

  let holdingDeploy, recoveryStarted = false;
  try {
  // Only start-command PATCH and pinned deploy POST are permitted in this
  // source-only rehearsal. Never retry a mutation after an ambiguous result.
  emit({ phase: "before_hold_config" });
  await request("", "PATCH", { serviceDetails: { envSpecificDetails: { startCommand: HOLD } } });
  current = await inspect(request, expectedDeploy, true);
  if (await readRuntime() !== "drained") throw Error("Drain readiness changed after holding configuration.");
  emit({ phase: "before_hold_deploy", commit: COMMIT });
  const result = await request("/deploys", "POST", { commitId: COMMIT, clearCache: "do_not_clear" });
  const deployment = result?.deploy || result;
  if (!/^dep-[a-z0-9]+$/.test(deployment?.id || "")) throw Error("Holding deployment response ambiguous; inspect before any retry.");
  holdingDeploy = deployment.id;
  emit({ phase: "hold_deploy_requested", deployId: holdingDeploy });
  const holdDeadline = now() + 180000;
  while (now() < holdDeadline) {
    // Inspect only the specific in-progress deployment here. Full inspect
    // deliberately rejects active deployments and is used at both boundaries.
    const raw = await request(`/deploys/${holdingDeploy}`);
    const d = raw?.deploy || raw;
    if (d.commit?.id !== COMMIT) throw Error("Holding deployment code changed.");
    if (d.status === "live") {
      await inspect(request, holdingDeploy, true);
      if (await readRuntime() !== "standalone") throw Error("Standalone holding runtime not observed.");
      emit({ phase: "hold_verified", deployId: holdingDeploy });
      // No browser wait, no copy, no approval gap while production is held.
      recoveryStarted = true;
      await recover({ request, expectedDeploy: holdingDeploy,
        approved: "source-only-before-any-destination-writes", emit, fetchImpl, now, wait });
      emit({ phase: "rehearsal_complete", cutoverReady: false, customerDeliveryVerified: false });
      return;
    }
    if (STOPPED.has(d.status)) throw Error("Holding deployment failed; source may still be drained. Manual recovery required.");
    if (!["created", "build_in_progress", "pre_deploy_in_progress", "update_in_progress"].includes(d.status))
      throw Error("Unknown holding deployment status; manual review required.");
    await wait(3000);
  }
  throw Error("Holding deployment deadline exceeded; inspect before any recovery mutation.");
  } catch (error) {
    if (recoveryStarted) throw error; // An uncertain recovery POST is never repeated.
    // A failed holding transition can leave the old, fully drained application
    // live. Restore it only after the API says no deployment is active and its
    // public runtime still proves all work drained. Do not kill pending builds.
    const state = await inspect(request);
    if (![expectedDeploy, holdingDeploy].includes(state.liveDeploy)) throw error;
    const mode = await readRuntime();
    if (!["drained", "standalone"].includes(mode)) throw error;
    emit({ phase: "holding_transition_failed_recovering_source", liveDeploy: state.liveDeploy });
    await recover({ request, expectedDeploy: state.liveDeploy,
      approved: "source-only-before-any-destination-writes", allowDrainedApplication: true,
      emit, fetchImpl, now, wait });
    emit({ phase: "rehearsal_failed_source_restored", cutoverReady: false });
    throw error;
  }
}

async function main() {
  if (process.env.RENDER_SERVICE_ID) throw Error("Run only on the independent runner.");
  if (process.env.MIGRATION_DEST_URL || process.env.NEUTRO_FINAL_COPY_APPROVED)
    throw Error("Rehearsal forbids destination credentials and final-copy configuration.");
  if (process.argv[2] !== "--source-only-rehearsal") throw Error("Explicit source-only rehearsal mode required.");
  await run({ request: api(process.env.RENDER_API_KEY),
    approved: process.env.NEUTRO_REHEARSAL_APPROVED,
    expectedDeploy: process.env.NEUTRO_EXPECTED_SOURCE_DEPLOY,
    emit: journal("neutro-rehearsal-journal.json") });
}
if (require.main === module) main().catch(() => {
  console.error("REHEARSAL_STOPPED: inspect the last journal phase and Render state; do not retry a deployment blindly.");
  process.exitCode = 1;
});
module.exports = { APPROVAL, runtime, journal, run };
