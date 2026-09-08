const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ClientReadinessError,
  evaluateReadiness,
  normalizeRequiredChannels,
  validateRuntimeReadinessContract,
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

function healthySystemHealth() {
  return {
    database: {
      status: "healthy",
      migrationState: "up_to_date",
      summary: "Database is current.",
    },
    inbound: {
      status: "healthy",
      summary: "Inbound processing is keeping up.",
    },
    ai: {
      status: "healthy",
      summary: "AI providers are ready.",
    },
    messaging: [
      {
        channel: "whatsapp",
        configured: true,
        status: "healthy",
        lastInboundAt: "2026-09-08T13:00:00.000Z",
        lastSuccessfulOutboundAt: "2026-09-08T13:00:03.000Z",
        recentDeliveryFailures: 0,
        lastDeliveryFailureAt: null,
      },
      {
        channel: "facebook",
        configured: true,
        status: "healthy",
        lastInboundAt: "2026-09-08T13:00:00.000Z",
        lastSuccessfulOutboundAt: "2026-09-08T13:00:03.000Z",
        recentDeliveryFailures: 0,
        lastDeliveryFailureAt: null,
      },
      {
        channel: "instagram",
        configured: true,
        status: "healthy",
        lastInboundAt: "2026-09-08T13:00:00.000Z",
        lastSuccessfulOutboundAt: "2026-09-08T13:00:03.000Z",
        recentDeliveryFailures: 0,
        lastDeliveryFailureAt: null,
      },
    ],
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
    systemHealth: healthySystemHealth(),
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

test("a required check that reports ready but is not configured still blocks go-live", () => {
  const data = overview();
  data.checks = data.checks.map((item) =>
    item.key === "public_url"
      ? { ...item, configured: false, status: "ready", summary: "Detected from request only." }
      : item
  );

  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.blocking.some((item) => item.key === "public_url" && item.status === "not_configured"), true);
});

test("a purchased channel stays blocked until its Setup Status evidence is ready", () => {
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

test("real inbound without a newer successful outbound reply blocks go-live", () => {
  const data = overview();
  data.systemHealth.messaging = data.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          lastInboundAt: "2026-09-08T13:05:00.000Z",
          lastSuccessfulOutboundAt: "2026-09-08T13:04:59.000Z",
        }
      : item
  );

  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.blocking.some((item) => item.key === "whatsapp_round_trip_outbound"), true);
});

test("a newer unresolved delivery failure blocks go-live", () => {
  const data = overview();
  data.systemHealth.messaging = data.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          status: "warning",
          lastDeliveryFailureAt: "2026-09-08T13:00:05.000Z",
          lastSuccessfulOutboundAt: "2026-09-08T13:00:03.000Z",
        }
      : item
  );

  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.blocking.some((item) => item.key === "whatsapp_delivery_failure"), true);
});

test("degraded but available AI becomes READY WITH WARNINGS", () => {
  const data = overview();
  data.systemHealth.ai = {
    status: "warning",
    summary: "One Gemini key is cooling down; another provider remains available.",
  };

  const report = evaluateReadiness(data, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, true);
  assert.equal(report.status, "ready_with_warnings");
  assert.equal(report.warnings.some((item) => item.key === "system_health_ai"), true);
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

test("runtime preflight catches deterministic missing purchased-channel/core credentials", () => {
  assert.throws(
    () => validateRuntimeReadinessContract({
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "password",
      GEMINI_API_KEY_1: "gemini-key",
      R2_ACCOUNT_ID: "r2",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET_NAME: "bucket",
      INSTAGRAM_PAGE_ID: "ig-page",
      // INSTAGRAM_PAGE_ACCESS_TOKEN intentionally missing
      META_APP_SECRET: "meta-secret",
      META_VERIFY_TOKEN: "verify",
    }, ["instagram"]),
    (err) => err.code === "READINESS_RUNTIME_CONFIG_MISSING"
      && /INSTAGRAM_PAGE_ACCESS_TOKEN/.test(err.message)
  );
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
  assert.equal(report.verificationCompleted, true);
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