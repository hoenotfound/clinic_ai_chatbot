const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ClientReadinessError,
  evaluateReadiness,
  normalizeRequiredChannels,
  verifyClientReadiness,
} = require("../src/provisioning/readinessVerifier");

function readyBusinessProfile(businessType = "home_renovation") {
  return {
    businessType,
    selection: { locked: true },
    alignment: {
      pipeline: { businessType },
      conversion: { businessType },
      leadTemperature: { businessType },
      analytics: { businessType, fallback: false },
    },
  };
}

function check(key, status = "ready", optional = false, summary = `${key} is ready`) {
  return {
    key,
    label: key,
    status,
    optional,
    configured: status !== "not_configured",
    summary,
    checkedAt: "2026-09-08T13:00:00.000Z",
  };
}

function overview(overrides = {}) {
  return {
    checkedAt: "2026-09-08T13:00:00.000Z",
    businessProfile: readyBusinessProfile(),
    checks: [
      check("database"),
      check("security"),
      check("public_url"),
      check("admin_account"),
      check("ai"),
      check("r2"),
      check("whatsapp"),
      check("whatsapp_webhook"),
      check("facebook", "not_configured", true),
      check("instagram", "not_configured", true),
      check("meta_webhook", "not_configured", true),
      check("telegram", "not_configured", true),
    ],
    ...overrides,
  };
}

function fakeHeaders(setCookies = []) {
  return {
    getSetCookie() {
      return setCookies;
    },
    get(name) {
      if (String(name).toLowerCase() === "set-cookie") return setCookies.join(", ");
      return null;
    },
  };
}

function response(status, body, setCookies = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders(setCookies),
    async json() {
      return body;
    },
  };
}

test("required channel aliases normalize and deduplicate", () => {
  assert.deepEqual(
    normalizeRequiredChannels("wa,messenger,ig,whatsapp"),
    ["whatsapp", "facebook", "instagram"]
  );
  assert.throws(
    () => normalizeRequiredChannels("telegram"),
    (err) => err instanceof ClientReadinessError && err.code === "READINESS_CHANNEL_UNSUPPORTED"
  );
  assert.throws(
    () => normalizeRequiredChannels(""),
    (err) => err.code === "READINESS_CHANNELS_REQUIRED"
  );
});

test("unpurchased channels do not block an otherwise ready client", () => {
  const report = evaluateReadiness(overview(), {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, true);
  assert.equal(report.status, "ready");
  assert.deepEqual(report.requiredChannels, ["whatsapp"]);
  assert.deepEqual(report.channelChecks.map((item) => item.key), ["whatsapp", "whatsapp_webhook"]);
  assert.equal(report.blocking.length, 0);
});

test("a purchased channel stays blocked until its real messaging evidence is ready", () => {
  const data = overview();
  data.checks = data.checks.map((item) =>
    item.key === "instagram"
      ? { ...item, status: "warning", configured: true, summary: "Configured. Send and receive a test message to confirm messaging." }
      : item.key === "meta_webhook"
        ? { ...item, status: "warning", configured: true, summary: "Waiting for the first valid signed webhook from Meta." }
        : item
  );

  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["instagram"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.status, "needs_attention");
  assert.equal(report.blocking.some((item) => item.key === "instagram"), true);
  assert.equal(report.blocking.some((item) => item.key === "meta_webhook"), true);
});

test("business profile mismatch blocks go-live even when integrations are ready", () => {
  const report = evaluateReadiness(overview({
    businessProfile: readyBusinessProfile("aesthetic_clinic"),
  }), {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.businessProfile.status, "error");
  assert.equal(report.blocking[0].key, "business_profile");
});

test("a required core application warning blocks readiness", () => {
  const data = overview();
  data.checks = data.checks.map((item) =>
    item.key === "ai" ? { ...item, status: "warning", summary: "Configured, but not checked yet." } : item
  );
  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });
  assert.equal(report.ready, false);
  assert.equal(report.blocking.some((item) => item.key === "ai"), true);
});

test("verifier logs in, carries both signed session cookies, runs Setup Status and logs out", async () => {
  const calls = [];
  const adminPassword = "super-secret-admin-password";
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/auth/login")) {
      const submitted = JSON.parse(options.body);
      assert.equal(submitted.username, "admin");
      assert.equal(submitted.password, adminPassword);
      return response(200, { username: "admin" }, [
        "session=abc123; Path=/; HttpOnly; Secure",
        "session.sig=signed456; Path=/; HttpOnly; Secure",
      ]);
    }
    if (String(url).endsWith("/api/setup-status/run")) {
      assert.equal(options.headers.Cookie, "session=abc123; session.sig=signed456");
      return response(200, overview());
    }
    if (String(url).endsWith("/api/auth/logout")) {
      assert.equal(options.headers.Cookie, "session=abc123; session.sig=signed456");
      return response(200, { ok: true });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const report = await verifyClientReadiness({
    baseUrl: "https://client.example/",
    username: "admin",
    password: adminPassword,
    expectedIndustry: "home_renovation",
    requiredChannels: "whatsapp",
    fetchImpl,
  });

  assert.equal(report.ready, true);
  assert.equal(calls.length, 3);
  assert.equal(JSON.stringify(report).includes(adminPassword), false);
});

test("rejected admin login fails safely without echoing the password", async () => {
  const password = "do-not-echo-me";
  await assert.rejects(
    verifyClientReadiness({
      baseUrl: "https://client.example",
      username: "admin",
      password,
      expectedIndustry: "home_renovation",
      requiredChannels: "whatsapp",
      fetchImpl: async () => response(401, { error: `bad password ${password}` }),
    }),
    (err) => {
      assert.equal(err.code, "READINESS_LOGIN_REJECTED");
      assert.equal(err.message.includes(password), false);
      return true;
    }
  );
});
