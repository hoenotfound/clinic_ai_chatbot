const test = require("node:test");
const assert = require("node:assert/strict");
const { SERVICE, WORKSPACE, COMMIT, HOLD, api, validate, recover } = require("../scripts/neutroMigrationRecovery.cjs");
const SOURCE = "postgresql://test:private@ep-patient-queen-b31tib05-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb";
const service = () => ({ id: SERVICE, ownerId: WORKSPACE, type: "web_service",
  repo: "https://github.com/hoenotfound/clinic_ai_chatbot", autoDeployTrigger: "off",
  suspended: "not_suspended", serviceDetails: { env: "node", numInstances: 1,
    maintenanceMode: { enabled: false }, envSpecificDetails: { startCommand: HOLD } } });
const live = id => ({ id, status: "live", commit: { id: COMMIT } });
function fixture() {
  const f = { service: service(), db: SOURCE, deploys: [{ deploy: live("dep-hold") }],
    calls: [], events: [], posted: false, holding: true, approved: "source-only-before-any-destination-writes", expectedDeploy: "dep-hold" };
  f.request = async (path, method = "GET", body) => {
    f.calls.push({ path, method, body });
    if (path === "" && method === "PATCH") {
      f.service.serviceDetails.envSpecificDetails = body.serviceDetails.envSpecificDetails;
      return f.service;
    }
    if (path === "") return structuredClone(f.service);
    if (path === "/env-vars/DATABASE_URL") return { value: f.db };
    if (path === "/deploys?limit=100") return structuredClone(f.deploys);
    if (path === "/deploys" && method === "POST") {
      f.posted = true;
      f.deploys = [{ deploy: live("dep-recovery") }, { deploy: { ...live("dep-hold"), status: "deactivated" } }];
      f.holding = false;
      return { id: "dep-recovery" };
    }
    if (path === "/deploys/dep-recovery") return live("dep-recovery");
    throw Error("Unexpected test request.");
  };
  f.fetchImpl = async () => ({ status: 200, text: async () => f.holding ? JSON.stringify({ mode: "migration_hold", chatbotRunning: false }) : "AI messaging bot is running." });
  f.emit = event => f.events.push(event);
  return f;
}

test("read-only validation accepts current source and never reveals credentials", () => {
  const f = fixture();
  const result = validate(f.service, f.db, f.deploys);
  assert.equal(result.sourceDatabase, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
for (const [name, change] of [
  ["destination database", f => { f.db = f.db.replace("ep-patient-queen-b31tib05-pooler.c-4", "ep-late-dawn-aog3aefy-pooler.c-2"); }],
  ["wrong database name", f => { f.db += "_other"; }],
  ["wrong workspace", f => { f.service.ownerId = "other"; }],
  ["multiple instances", f => { f.service.serviceDetails.numInstances = 2; }],
  ["automatic deployment", f => { f.service.autoDeployTrigger = "commit"; }],
  ["changed commit", f => { f.deploys[0].deploy.commit.id = "b".repeat(40); }],
  ["changed deployment", f => { f.deploys[0].deploy.id = "dep-other"; }],
  ["pending deployment", f => { f.deploys.unshift({ deploy: { status: "build_in_progress" } }); }],
  ["unknown deployment status", f => { f.deploys.unshift({ deploy: { status: "new_status" } }); }],
  ["normal start command", f => { f.service.serviceDetails.envSpecificDetails.startCommand = "npm start"; }],
  ["public app already running", f => { f.holding = false; }],
  ["missing approval", f => { f.approved = ""; }],
]) test(`blocks ${name} before any mutation`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(recover(f));
  assert.equal(f.calls.some(c => c.method !== "GET"), false);
});

test("rechecks database after health probe and refuses concurrent cutover", async () => {
  const f = fixture(); const probe = f.fetchImpl;
  f.fetchImpl = async () => { const r = await probe(); f.db = "postgresql://test:private@example.test/neondb"; return r; };
  await assert.rejects(recover(f), /source/);
  assert.equal(f.calls.some(c => c.method !== "GET"), false);
});
test("source recovery uses only approved command and exact commit, preserves environment", async () => {
  const f = fixture(); await recover(f);
  const mutations = f.calls.filter(c => c.method !== "GET");
  assert.deepEqual(mutations, [
    { path: "", method: "PATCH", body: { serviceDetails: { envSpecificDetails: { startCommand: "npm start" } } } },
    { path: "/deploys", method: "POST", body: { commitId: COMMIT, clearCache: "do_not_clear" } },
  ]);
  assert.equal(f.events.at(-1).phase, "source_deploy_live");
  assert.equal(f.events.at(-1).customerDeliveryVerified, false);
});
test("lost deploy response is not retried and no success is claimed", async () => {
  const f = fixture(); const request = f.request;
  f.request = async (...args) => { const r = await request(...args); if (args[1] === "POST") throw Error("Connection lost."); return r; };
  await assert.rejects(recover(f));
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(f.events.some(e => e.phase === "source_deploy_live"), false);
});
test("failed deployment stops without a second deployment", async () => {
  const f = fixture(); const request = f.request;
  f.request = async (...args) => args[0] === "/deploys/dep-recovery" ? { ...live("dep-recovery"), status: "update_failed" } : request(...args);
  await assert.rejects(recover(f), /without becoming live/);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
test("monitoring has a bounded deadline", async () => {
  const f = fixture(); const request = f.request; let now = 0;
  f.request = async (...args) => args[0] === "/deploys/dep-recovery" ? { ...live("dep-recovery"), status: "build_in_progress" } : request(...args);
  f.now = () => now; f.wait = async ms => { now += ms; };
  await assert.rejects(recover(f), /deadline/);
  assert.equal(now, 900000);
});
test("API failures never echo credentials or provider bodies and forbid redirects", async () => {
  let seen;
  const request = api("secret-key", async (_url, options) => { seen = options; return { ok: false, status: 403, text: async () => "secret-key private customer" }; });
  await assert.rejects(request(""), error => !error.message.includes("secret-key") && !error.message.includes("customer"));
  assert.equal(seen.redirect, "error");
  assert.throws(() => api(""), /missing/);
});

test("recovery tolerates a briefly stale holding response after live without another deployment", async () => {
  const f = fixture(), originalFetch=f.fetchImpl;
  let postLiveSamples=0,clock=0;
  f.now=()=>clock; f.wait=async ms=>{clock+=ms;};
  f.fetchImpl=async()=>{
    if(f.posted && postLiveSamples++===0) return {status:200,text:async()=>JSON.stringify({mode:'migration_hold',chatbotRunning:false})};
    return originalFetch();
  };
  await recover(f);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(f.events.some(e=>e.phase==='source_readiness_wait'),true);
  assert.equal(f.events.at(-1).phase,'source_deploy_live');
});

test("permanent readiness failure has a bounded read-only wait and never reports recovery success",async()=>{
  const f=fixture(),originalFetch=f.fetchImpl; let clock=0;
  f.now=()=>clock; f.wait=async ms=>{clock+=ms;};
  f.fetchImpl=async()=>f.posted?{status:503,text:async()=>'private provider body'}:originalFetch();
  await assert.rejects(recover(f),/readiness verification deadline/);
  assert.equal(clock,60000);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(f.events.some(e=>e.phase==='source_deploy_live'),false);
  assert.equal(JSON.stringify(f.events).includes('private'),false);
});

test("source identity change during readiness wait aborts without retrying mutations",async()=>{
  const f=fixture(),originalFetch=f.fetchImpl;
  f.fetchImpl=async()=>{
    if(f.posted){f.db='postgresql://test:synthetic@example.test/neondb';return {status:503,text:async()=>''};}
    return originalFetch();
  };
  f.wait=async()=>{};
  await assert.rejects(recover(f),/identity or configuration/);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
  assert.deepEqual(f.events.at(-1),{phase:'source_verification_failed',reason:'source_identity_or_configuration'});
});

test("a normal public response cannot mask a concurrent database identity change",async()=>{
  const f=fixture(),originalFetch=f.fetchImpl;
  f.fetchImpl=async()=>{
    const response=await originalFetch();
    if(f.posted)f.db='postgresql://test:synthetic@example.test/neondb';
    return response;
  };
  await assert.rejects(recover(f),/identity or configuration/);
  assert.equal(f.events.some(e=>e.phase==='source_deploy_live'),false);
  assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
