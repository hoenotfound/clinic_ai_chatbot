const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMetaRouterPoolConfig,
  routerDatabaseEnv,
} = require("../src/metaRouter/db");

test("Meta router prefers its dedicated database URL over Ops Registry credentials", () => {
  const mapped = routerDatabaseEnv({
    META_ROUTER_DATABASE_URL: "postgres://router:secret@localhost:5432/router",
    OPS_DATABASE_URL: "postgres://ops:secret@localhost:5432/ops",
    META_ROUTER_DATABASE_POOL_MAX: "2",
  });

  assert.equal(
    mapped.OPS_DATABASE_URL,
    "postgres://router:secret@localhost:5432/router",
  );
  assert.equal(mapped.OPS_DATABASE_POOL_MAX, "2");
});

test("embedded Meta router database mode refuses to fall back to OPS_DATABASE_URL", () => {
  assert.throws(
    () => routerDatabaseEnv(
      { OPS_DATABASE_URL: "postgres://ops:secret@localhost:5432/ops" },
      { allowOpsFallback: false },
    ),
    /META_ROUTER_DATABASE_URL is required/i,
  );
});

test("standalone Meta router retains OPS_DATABASE_URL fallback for migration compatibility", () => {
  const mapped = routerDatabaseEnv(
    { OPS_DATABASE_URL: "postgres://ops:secret@localhost:5432/ops" },
    { allowOpsFallback: true },
  );
  assert.equal(mapped.OPS_DATABASE_URL, "postgres://ops:secret@localhost:5432/ops");
});

test("Meta router pool identifies itself separately and defaults to a small pool", () => {
  const config = buildMetaRouterPoolConfig({
    META_ROUTER_DATABASE_URL: "postgres://router:secret@localhost:5432/router",
  });

  assert.equal(config.application_name, "da-chatbot-meta-router");
  assert.equal(config.max, 3);
  assert.equal(config.ssl, false);
});
