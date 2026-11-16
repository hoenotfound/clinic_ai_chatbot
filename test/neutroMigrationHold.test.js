const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { SOURCE_HOST, ROUTER_HOST, validateEnvironment, createHoldApp } = require("../scripts/neutroMigrationHold.cjs");
const { expectedMetaSignature } = require("../src/metaRouter/server");

function env() {
  return {
    CLIENT_SLUG: "neutro-sense-tcm", NEUTRO_MIGRATION_HOLD: "20261116",
    DATABASE_URL: `postgres://synthetic:synthetic@${SOURCE_HOST}/neondb`,
    META_ROUTER_DATABASE_URL: `postgres://synthetic:synthetic@${ROUTER_HOST}/neondb`,
    META_ROUTER_ENABLED: "true", META_APP_SECRET: "test-signature-secret",
    META_VERIFY_TOKEN: "test-verify-token",
  };
}
async function withServer(app, run) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function route(clientSlug, assetId = "page-test") {
  return { clientSlug, assetId, channel: "facebook", enabled: true, targetBaseUrl: `https://${clientSlug}.example.test` };
}
function post(base, body, signature = expectedMetaSignature(env().META_APP_SECRET, Buffer.from(JSON.stringify(body)))) {
  return fetch(base + "/meta-router/meta-webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: JSON.stringify(body),
  });
}

test("hold requires explicit scope and rejects preloads or unexpected connections without printing secrets", () => {
  assert.deepEqual(validateEnvironment(env(), []), { applicationHost: SOURCE_HOST });
  for (const overrides of [
    { NEUTRO_MIGRATION_HOLD: undefined }, { CLIENT_SLUG: "other" },
    { DATABASE_URL: "postgres://user:DO_NOT_PRINT@other.test/neondb" },
    { META_ROUTER_DATABASE_URL: env().DATABASE_URL },
    { NODE_OPTIONS: "--require ./src/services/embeddedMetaRouterBootstrap.js" },
    { META_ROUTER_ENABLED: "false" }, { META_ROUTER_MOUNT_PATH: "/unexpected" },
  ]) assert.throws(() => validateEnvironment({ ...env(), ...overrides }, []), e => !e.message.includes("DO_NOT_PRINT"));
  assert.throws(() => validateEnvironment(env(), ["-r", "./src/server.js"]), /preloads/);
});

test("both WhatsApp callbacks, direct social callback and staff writes return 503 without querying data", async () => {
  let reads = 0;
  const app = createHoldApp({ env: env(), repo: { getRoutes: async () => { reads++; return []; } }, healthCheck: async () => {} });
  await withServer(app, async base => {
    for (const url of ["/webhook", "/whatsapp/default", "/meta-webhook", "/api/conversations/1/messages", "/whatsapp/secondary-qa-capture"]) {
      const r = await fetch(base + url, { method: "POST", body: '{"synthetic":true}' });
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "60");
    }
    const r = await fetch(base + "/");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { mode: "migration_hold", chatbotRunning: false });
    assert.equal(reads, 0);
  });
});

test("shared router still validates signatures and forwards other clients once", async () => {
  let forwarded = 0;
  const app = createHoldApp({ env: env(), healthCheck: async () => {},
    repo: { getRoutes: async () => [route("other")] },
    fetchImpl: async (_url, options) => { forwarded++; assert.equal(options.method, "POST"); return { ok: true, status: 200 }; },
  });
  const body = { object: "page", entry: [{ id: "page-test", messaging: [{ message: { mid: "synthetic-only" } }] }] };
  await withServer(app, async base => {
    assert.equal((await post(base, body, "sha256=invalid")).status, 403);
    assert.equal(forwarded, 0);
    assert.equal((await post(base, body)).status, 200);
    assert.equal(forwarded, 1);
  });
});

test("Neutro and mixed batches return 503 before any external forwarding", async () => {
  for (const routes of [[route("neutro-sense-tcm")], [route("other", "other-page"), route("neutro-sense-tcm")],
    [{ ...route("renamed"), targetBaseUrl: "https://neutrosense.dasmarketingsolution.com" }]]) {
    let forwarded = 0;
    const app = createHoldApp({ env: env(), healthCheck: async () => {}, repo: { getRoutes: async () => routes },
      fetchImpl: async () => { forwarded++; return { ok: true, status: 200 }; } });
    await withServer(app, async base => {
      assert.equal((await post(base, { object: "page", entry: routes.map(r => ({ id: r.assetId })) })).status, 503);
      assert.equal(forwarded, 0);
    });
  }
});

test("router failure and health failure do not produce a success acknowledgment", async () => {
  const app = createHoldApp({ env: env(), healthCheck: async () => { throw Error("synthetic outage"); },
    repo: { getRoutes: async () => [route("other")] }, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await withServer(app, async base => {
    assert.equal((await fetch(base + "/")).status, 503);
    assert.equal((await post(base, { object: "page", entry: [{ id: "page-test" }] })).status, 503);
  });
});

test("holding process never imports application database, startup or sender modules", () => {
  const script = `const h=require('./scripts/neutroMigrationHold.cjs');h.createHoldApp({env:{META_APP_SECRET:'synthetic',META_VERIFY_TOKEN:'synthetic'},repo:{getRoutes:async()=>[]},healthCheck:async()=>{}});const forbidden=Object.keys(require.cache).filter(p=>/src[\\\\/]db[\\\\/]db\\.js$|applicationStartup|whatsappService|whatsappSenderOutboundTransport|src[\\\\/]server\\.js$/.test(p));if(forbidden.length)process.exit(2);`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
