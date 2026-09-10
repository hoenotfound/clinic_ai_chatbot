const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildOpsPoolConfig } = require("../src/ops/db");
const { dashboardHtml, clientDetailHtml } = require("../src/ops/dashboard");
const {
  createSingleFlight,
  shutdownGraceMs,
} = require("../src/ops/server");
const {
  offlineAfterMs,
  pollIntervalMs,
} = require("../src/ops/runtimeConfig");
const {
  inspectClientTokens,
  parseArgs,
  redactOpsText,
  validateConfiguration,
} = require("../scripts/verifyOpsRegistry");
const {
  normalizedRegistryUrl,
  runSmoke,
} = require("../scripts/smokeOpsRegistry");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("production Ops database verifies TLS and bounds pool/network waits", () => {
  const remote = buildOpsPoolConfig({
    OPS_DATABASE_URL: "postgresql://user:pass@db.example.com/ops?sslmode=require",
  });
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true });
  assert.equal(remote.connectionString.includes("sslmode="), false);
  assert.equal(remote.connectionTimeoutMillis, 5000);
  assert.equal(remote.query_timeout, 10000);
  assert.equal(remote.max, 5);
  assert.equal(remote.application_name, "da-chatbot-ops-registry");

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

test("Ops dashboard uses guarded actions, CSP nonces and a useful first-client empty state", () => {
  const dashboard = dashboardHtml("test-nonce");
  const detail = clientDetailHtml("example-client", "test-nonce");
  assert.match(dashboard, /"x-ops-action":"1"/);
  assert.match(detail, /"x-ops-action":"1"/);
  assert.match(dashboard, /No client deployments registered/);
  assert.match(dashboard, /ops-registry:verify/);
  assert.match(dashboard, /<script nonce="test-nonce">/);
  assert.match(dashboard, /<style nonce="test-nonce">/);
  assert.match(detail, /<script nonce="test-nonce">/);
  assert.doesNotMatch(detail, /style="margin-top:/);
});

test("Ops preflight validates config, redacts errors and rejects duplicate credentials", () => {
  const sharedToken = "a".repeat(32);
  const env = {
    OPS_REGISTRY_MODE: "true",
    OPS_DATABASE_URL: "postgresql://user:secret-password@localhost:5432/ops",
    OPS_REGISTRY_ADMIN_USERNAME: "ops",
    OPS_REGISTRY_ADMIN_PASSWORD: "very-secret-admin-password",
    OPS_CLIENT_TOKEN_ACME: sharedToken,
    OPS_CLIENT_TOKEN_BETA: sharedToken,
  };
  const config = validateConfiguration(env);
  assert.equal(config.every((check) => check.ok), true);
  assert.equal(JSON.stringify(config).includes("secret-password"), false);
  assert.equal(JSON.stringify(config).includes("very-secret-admin-password"), false);

  const tokens = inspectClientTokens([
    { clientSlug: "acme", tokenEnvKey: "OPS_CLIENT_TOKEN_ACME" },
    { clientSlug: "beta", tokenEnvKey: "OPS_CLIENT_TOKEN_BETA" },
  ], env);
  assert.equal(tokens.some((check) => check.ok === false && /duplicates acme/i.test(check.label)), true);
  assert.equal(JSON.stringify(tokens).includes(sharedToken), false);

  const duplicateKeys = inspectClientTokens([
    { clientSlug: "acme", tokenEnvKey: "OPS_CLIENT_TOKEN_ACME" },
    { clientSlug: "beta", tokenEnvKey: "OPS_CLIENT_TOKEN_ACME" },
  ], env);
  assert.equal(duplicateKeys.some((check) => check.ok === false && /also assigned to acme/i.test(check.label)), true);

  const message = `database ${env.OPS_DATABASE_URL}; password=${env.OPS_REGISTRY_ADMIN_PASSWORD}; token=${sharedToken}`;
  const redacted = redactOpsText(message, env);
  assert.equal(redacted.includes(env.OPS_DATABASE_URL), false);
  assert.equal(redacted.includes(env.OPS_REGISTRY_ADMIN_PASSWORD), false);
  assert.equal(redacted.includes(sharedToken), false);
});

test("Ops preflight CLI has an explicit optional client probe", () => {
  assert.deepEqual(parseArgs([]), { probeClients: false });
  assert.deepEqual(parseArgs(["--probe-clients"]), { probeClients: true });
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("offline threshold grows with slower polling and shutdown stays below Render allowance", () => {
  assert.equal(pollIntervalMs({ OPS_POLL_INTERVAL_MS: "300000" }), 300000);
  assert.equal(offlineAfterMs({ OPS_POLL_INTERVAL_MS: "300000" }), 15 * 60 * 1000);
  assert.equal(offlineAfterMs({ OPS_POLL_INTERVAL_MS: "1800000" }), 90 * 60 * 1000);
  assert.equal(shutdownGraceMs({}), 100000);
  assert.equal(shutdownGraceMs({ OPS_SHUTDOWN_GRACE_MS: "999999" }), 110000);
});

test("production deployment assets pin the intended safe Render contract", () => {
  const envExample = source(".env.example");
  const blueprint = source("render.ops.yaml");
  const runbook = source("docs/ops-registry-deployment.md");
  const packageJson = JSON.parse(source("package.json"));
  const uniqueTokenMigration = source("src/ops/migrations/002_unique_token_env_key.sql");
  const repoSource = source("src/ops/clientRegistryRepo.js");

  assert.match(envExample, /OPS_REGISTRY_MODE=false/);
  assert.match(envExample, /OPS_DATABASE_SSL_REJECT_UNAUTHORIZED=true/);
  assert.match(envExample, /OPS_AUTH_MAX_TRACKED_ADDRESSES=1000/);
  assert.match(envExample, /OPS_SHUTDOWN_GRACE_MS=100000/);
  assert.match(blueprint, /region: singapore/);
  assert.match(blueprint, /numInstances: 1/);
  assert.match(blueprint, /preDeployCommand: npm run ops-registry:migrate/);
  assert.match(blueprint, /maxShutdownDelaySeconds: 120/);
  assert.match(blueprint, /autoDeployTrigger: checksPass/);
  assert.match(blueprint, /healthCheckPath: \/healthz/);
  assert.match(runbook, /Blueprint file path/i);
  assert.match(runbook, /aws-ap-southeast-1/);
  assert.match(runbook, /Rollback/);
  assert.match(uniqueTokenMigration, /UNIQUE INDEX/i);
  assert.match(repoSource, /last_poll_at IS NULL OR last_poll_at <= \$2/);
  assert.equal(packageJson.scripts["ops-registry:verify"], "node scripts/verifyOpsRegistry.js");
  assert.equal(packageJson.scripts["ops-registry:smoke"], "node scripts/smokeOpsRegistry.js");
});

test("deployed smoke test checks health, auth boundary, CSP and action guard without refreshing", async () => {
  assert.equal(normalizedRegistryUrl("https://ops.example.com/"), "https://ops.example.com");
  assert.throws(() => normalizedRegistryUrl("http://ops.example.com"), /require HTTPS/i);

  const requests = [];
  const headers = new Map([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["content-security-policy", "default-src 'none'; frame-ancestors 'none'; script-src 'nonce-abc'"],
  ]);
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/healthz")) {
      return { status: 200, ok: true, json: async () => ({ ok: true }), headers: { get: () => null } };
    }
    if (url.endsWith("/api/refresh-all")) {
      return { status: 403, ok: false, headers: { get: () => null } };
    }
    if (!options.headers?.authorization) {
      return { status: 401, ok: false, headers: { get: () => null } };
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ schemaVersion: 1 }),
      headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    };
  };

  const checks = await runSmoke({
    baseUrl: "https://ops.example.com",
    authorization: "Basic test",
    fetchImpl,
  });
  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(requests.some((request) => request.url.endsWith("/api/refresh-all") && request.options.headers?.["x-ops-action"]), false);
});
