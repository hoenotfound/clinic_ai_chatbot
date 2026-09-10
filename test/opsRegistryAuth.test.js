const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRequireOpsAdmin,
  parseBasicAuth,
} = require("../src/ops/requireOpsAdmin");
const { createOpsRegistryApp } = require("../src/ops/server");
const { clientDetailHtml } = require("../src/ops/dashboard");

test("basic auth parser preserves colons in the password", () => {
  const header = `Basic ${Buffer.from("admin:pass:word").toString("base64")}`;
  assert.deepEqual(parseBasicAuth(header), { username: "admin", password: "pass:word" });
});

test("client detail page safely embeds an untrusted route slug", () => {
  const html = clientDetailHtml('</script><script>alert("xss")</script>', "test-nonce");
  assert.equal(html.includes('</script><script>alert("xss")</script>'), false);
  assert.match(html, /const clientSlug = "\\u003c\/script\\u003e/);
});

async function withServer(callback, authEnv = {}) {
  const fleetService = {
    listFleet: async () => ({ schemaVersion: 1, summary: { total: 1 }, clients: [{ clientSlug: "acme" }] }),
    getClient: async (slug) => slug === "acme"
      ? {
          clientSlug: "acme",
          displayName: "Acme",
          status: "ready",
          tokenConfigured: true,
          readiness: { status: "ready" },
        }
      : null,
    refreshAll: async () => ({ schemaVersion: 1, clients: [] }),
    refreshClient: async () => ({ clientSlug: "acme" }),
  };
  const app = createOpsRegistryApp({
    fleetService,
    authenticate: createRequireOpsAdmin({
      env: {
        OPS_REGISTRY_ADMIN_USERNAME: "ops",
        OPS_REGISTRY_ADMIN_PASSWORD: "long-enough-password",
        ...authEnv,
      },
    }),
    healthCheck: async () => true,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("registry health is public but fleet and detail data require operations admin auth", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/clients`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/clients/acme`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/refresh-all`, { method: "POST" })).status, 401);

    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;
    const response = await fetch(`${baseUrl}/api/clients`, {
      headers: { authorization },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).schemaVersion, 1);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'nonce-[^']+'/);
    assert.doesNotMatch(csp, /unsafe-inline/);

    const detail = await fetch(`${baseUrl}/api/clients/acme`, { headers: { authorization } });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.clientSlug, "acme");
    assert.equal(Object.hasOwn(body, "token"), false);
    assert.equal(Object.hasOwn(body, "tokenEnvKey"), false);
    assert.equal(Object.hasOwn(body, "databaseUrl"), false);
  });
});

test("authenticated refresh actions require the explicit Ops action header", async () => {
  await withServer(async (baseUrl) => {
    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;

    const missingHeader = await fetch(`${baseUrl}/api/refresh-all`, {
      method: "POST",
      headers: { authorization },
    });
    assert.equal(missingHeader.status, 403);

    const crossSite = await fetch(`${baseUrl}/api/refresh-all`, {
      method: "POST",
      headers: {
        authorization,
        "x-ops-action": "1",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossSite.status, 403);

    const allowed = await fetch(`${baseUrl}/api/refresh-all`, {
      method: "POST",
      headers: {
        authorization,
        "x-ops-action": "1",
      },
    });
    assert.equal(allowed.status, 200);
  });
});

test("repeated failed Ops admin authentication is throttled per source address", async () => {
  await withServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const badAuthorization = `Basic ${Buffer.from(`random-user-${attempt}:wrong-password`).toString("base64")}`;
      const response = await fetch(`${baseUrl}/api/clients`, {
        headers: { authorization: badAuthorization },
      });
      assert.equal(response.status, 401);
    }

    const blocked = await fetch(`${baseUrl}/api/clients`, {
      headers: { authorization: `Basic ${Buffer.from("another-user:wrong-password").toString("base64")}` },
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  }, {
    OPS_AUTH_MAX_FAILURES: "3",
    OPS_AUTH_WINDOW_MS: "10000",
  });
});

test("authentication limiter bounds tracked source addresses and prunes expired entries", () => {
  let currentTime = 1000;
  const middleware = createRequireOpsAdmin({
    env: {
      OPS_REGISTRY_ADMIN_USERNAME: "ops",
      OPS_REGISTRY_ADMIN_PASSWORD: "long-enough-password",
      OPS_AUTH_MAX_TRACKED_ADDRESSES: "100",
      OPS_AUTH_WINDOW_MS: "10000",
    },
    now: () => currentTime,
  });

  function attempt(remoteAddress) {
    const req = {
      socket: { remoteAddress },
      get(name) {
        if (name.toLowerCase() === "authorization") {
          return `Basic ${Buffer.from("bad-user:bad-password").toString("base64")}`;
        }
        return "";
      },
    };
    const res = {
      headers: new Map(),
      set(name, value) { this.headers.set(name, value); },
      status(code) { this.statusCode = code; return this; },
      send() { return this; },
    };
    middleware(req, res, () => {});
  }

  for (let index = 0; index < 150; index += 1) attempt(`10.0.0.${index}`);
  assert.equal(middleware.trackedAddressCount(), 100);

  currentTime += 10001;
  middleware.pruneExpired();
  assert.equal(middleware.trackedAddressCount(), 0);
});

test("unknown protected client detail returns 404", async () => {
  await withServer(async (baseUrl) => {
    const authorization = `Basic ${Buffer.from("ops:long-enough-password").toString("base64")}`;
    const response = await fetch(`${baseUrl}/api/clients/missing`, { headers: { authorization } });
    assert.equal(response.status, 404);
  });
});
