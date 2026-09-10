#!/usr/bin/env node
require("dotenv").config();

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value.`);
    if (arg === "--url") args.url = next;
    else throw new Error(`Unknown argument: ${arg}`);
    index += 1;
  }
  return args;
}

function usage() {
  return `
Smoke-test a deployed DA Chatbot Ops Registry.

Usage:
  OPS_REGISTRY_ADMIN_USERNAME=... \\
  OPS_REGISTRY_ADMIN_PASSWORD=... \\
  npm run ops-registry:smoke -- --url https://your-registry.onrender.com

The admin password is intentionally read from the environment, not a CLI flag,
so it is less likely to be exposed in shell history or process listings.
`;
}

function normalizedRegistryUrl(value) {
  const url = new URL(String(value || "").trim());
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Ops Registry smoke tests require HTTPS outside localhost.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function requireCredentials(env = process.env) {
  const username = String(env.OPS_REGISTRY_ADMIN_USERNAME || "").trim();
  const password = String(env.OPS_REGISTRY_ADMIN_PASSWORD || "");
  if (!username || password.length < 16) {
    throw new Error("Valid OPS_REGISTRY_ADMIN_USERNAME and OPS_REGISTRY_ADMIN_PASSWORD are required.");
  }
  return { username, password };
}

async function checkResponse(label, request, validate = null) {
  try {
    const response = await request();
    const validation = validate ? await validate(response) : response.ok;
    if (!validation) {
      return { ok: false, label: `${label}: unexpected HTTP ${response.status}` };
    }
    return { ok: true, label };
  } catch (error) {
    return { ok: false, label: `${label}: ${error.message || error}` };
  }
}

async function runSmoke({ baseUrl, authorization, fetchImpl = global.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Ops Registry smoke test requires fetch().");
  const checks = [];

  checks.push(await checkResponse(
    "Public health endpoint is healthy",
    () => fetchImpl(`${baseUrl}/healthz`, { headers: { accept: "application/json" } }),
    async (response) => {
      if (response.status !== 200) return false;
      const body = await response.json().catch(() => null);
      return body?.ok === true;
    },
  ));

  checks.push(await checkResponse(
    "Fleet API rejects unauthenticated requests",
    () => fetchImpl(`${baseUrl}/api/clients`, { headers: { accept: "application/json" } }),
    (response) => response.status === 401,
  ));

  checks.push(await checkResponse(
    "Authenticated fleet API returns schema version 1",
    () => fetchImpl(`${baseUrl}/api/clients`, {
      headers: { authorization, accept: "application/json" },
    }),
    async (response) => {
      if (response.status !== 200) return false;
      const body = await response.json().catch(() => null);
      const csp = response.headers.get("content-security-policy") || "";
      return body?.schemaVersion === 1
        && response.headers.get("x-content-type-options") === "nosniff"
        && response.headers.get("x-frame-options") === "DENY"
        && /frame-ancestors 'none'/.test(csp)
        && !csp.includes("'unsafe-inline'");
    },
  ));

  checks.push(await checkResponse(
    "Refresh API rejects missing action confirmation",
    () => fetchImpl(`${baseUrl}/api/refresh-all`, {
      method: "POST",
      headers: { authorization, accept: "application/json" },
    }),
    (response) => response.status === 403,
  ));

  return checks;
}

async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = global.fetch } = {}) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    const baseUrl = normalizedRegistryUrl(args.url || env.OPS_REGISTRY_SMOKE_URL);
    const credentials = requireCredentials(env);
    const authorization = basicAuthorization(credentials.username, credentials.password);

    console.log(`DA Chatbot Ops Registry Smoke Test\nTarget: ${baseUrl}\n`);
    const checks = await runSmoke({ baseUrl, authorization, fetchImpl });
    for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.label}`);
    if (checks.some((check) => !check.ok)) return 1;
    console.log("\nOps Registry smoke test passed.");
    return 0;
  } catch (error) {
    console.error(error.message || error);
    console.error(usage());
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  basicAuthorization,
  main,
  normalizedRegistryUrl,
  parseArgs,
  requireCredentials,
  runSmoke,
  usage,
};
