const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildOpsPoolConfig } = require("../src/ops/db");
const { dashboardHtml, clientDetailHtml } = require("../src/ops/dashboard");
const { createSingleFlight } = require("../src/ops/server");
const {
  inspectClientTokens,
  parseArgs,
  validateConfiguration,
} = require("../scripts/verifyOpsRegistry");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("production Ops database verifies TLS by default and local development stays plaintext", () => {
  const remote = buildOpsPoolConfig({
    OPS_DATABASE_URL: "postgresql://user:pass@db.example.com/ops?sslmode=require",
  });
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.equal(remote.connectionString.includes("sslmode="), false);

  const explicitException = buildOpsPoolConfig({
    OPS_DATABASE_URL: "postgresql://user:pass@db.example.com/ops?sslmode=require",
    OPS_DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
  });
  assert.deepEqual(explicitException.ssl, { rejectUnauthorized: false });

  const local = buildOpsPoolConfig({
    OPS_DATABASE_URL: "postgresql://user:pass@localhost:5432/ops",
  });
  assert.equal(local.ssl, false);
});

test("fleet refresh single-flight reuses one active refresh promise", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = createSingleFlight(async () => {
    calls += 1;
    await gate;
    return { ok: true };
  });

  const first = run();
  const second = run();
  assert.equal(first, second);
  assert.equal(calls, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(run.inFlight(), null);
});

test("Ops dashboard uses guarded refresh actions and a useful first-client empty state", () => {
  const dashboard = dashboardHtml();
  const detail = clientDetailHtml("example-client");
  assert.match(dashboard, /"x-ops-action":"1"/);
  assert.match(detail, /"x-ops-action":"1"/);
  assert.match(dashboard, /No client deployments registered/);
  assert.match(dashboard, /ops-registry:verify/);
});

test("Ops preflight validates config and token presence without including secret values in labels", () => {
  const env = {
    OPS_REGISTRY_MODE: "true",
    OPS_DATABASE_URL: "postgresql://user:secret-password@localhost:5432/ops",
    OPS_REGISTRY_ADMIN_USERNAME: "ops",
    OPS_REGISTRY_ADMIN_PASSWORD: "very-secret-admin-password",
    OPS_CLIENT_TOKEN_ACME: "a".repeat(32),
  };
  const config = validateConfiguration(env);
  assert.equal(config.every((check) => check.ok), true);
  assert.equal(JSON.stringify(config).includes("secret-password"), false);
  assert.equal(JSON.stringify(config).includes("very-secret-admin-password"), false);

  const tokens = inspectClientTokens([
    { clientSlug: "acme", tokenEnvKey: "OPS_CLIENT_TOKEN_ACME" },
  ], env);
  assert.equal(tokens[0].ok, true);
  assert.equal(JSON.stringify(tokens).includes("a".repeat(32)), false);

  const missing = inspectClientTokens([
    { clientSlug: "missing", tokenEnvKey: "OPS_CLIENT_TOKEN_MISSING" },
  ], env);
  assert.equal(missing[0].ok, false);
});

test("Ops preflight CLI has an explicit optional client probe", () => {
  assert.deepEqual(parseArgs([]), { probeClients: false });
  assert.deepEqual(parseArgs(["--probe-clients"]), { probeClients: true });
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("production deployment assets describe the isolated registry contract", () => {
  const envExample = source(".env.example");
  const blueprint = source("render.ops.yaml");
  const runbook = source("docs/ops-registry-deployment.md");
  const packageJson = JSON.parse(source("package.json"));

  assert.match(envExample, /OPS_REGISTRY_MODE=false/);
  assert.match(envExample, /OPS_DATABASE_SSL_REJECT_UNAUTHORIZED=true/);
  assert.match(blueprint, /startCommand: npm run ops-registry:start/);
  assert.match(blueprint, /healthCheckPath: \/healthz/);
  assert.match(runbook, /separate Neon project\/database/i);
  assert.match(runbook, /Rollback/);
  assert.equal(packageJson.scripts["ops-registry:verify"], "node scripts/verifyOpsRegistry.js");
});
