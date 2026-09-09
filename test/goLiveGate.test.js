const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateGoLiveGate } = require("../src/services/goLiveGateService");

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
    checkedAt: "2026-09-09T10:00:00.000Z",
  };
}

function healthyMessaging(channel) {
  return {
    channel,
    configured: true,
    status: "healthy",
    evidence: "Real customer messaging activity has been observed.",
    lastInboundAt: "2026-09-09T10:00:00.000Z",
    lastSuccessfulOutboundAt: "2026-09-09T10:00:04.000Z",
    lastVerifiedAutomatedReplyAt: "2026-09-09T10:00:03.000Z",
    lastReadinessDeliveryFailureAt: null,
    recentDeliveryFailures: 0,
    lastDeliveryFailureAt: null,
  };
}

function setupOverview(overrides = {}) {
  return {
    checkedAt: "2026-09-09T10:00:05.000Z",
    lastRunAt: "2026-09-09T10:00:05.000Z",
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
    systemHealth: {
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
        healthyMessaging("whatsapp"),
        { ...healthyMessaging("facebook"), configured: false, status: "not_configured" },
        { ...healthyMessaging("instagram"), configured: false, status: "not_configured" },
      ],
    },
    ...overrides,
  };
}

function clientSetup(channels = ["whatsapp"], overrides = {}) {
  return {
    requiredComplete: true,
    requiredCompletedCount: 6,
    requiredTotal: 6,
    incompleteRequired: [],
    sections: [],
    channelContract: {
      configured: true,
      channels,
      error: null,
      source: "environment",
    },
    ...overrides,
  };
}

function evaluate({ overview = setupOverview(), completion = clientSetup(), config = {} } = {}) {
  return evaluateGoLiveGate({
    config: {
      businessType: "home_renovation",
      businessName: "Acme Renovation",
      ...config,
    },
    clientSetup: completion,
    setupOverview: overview,
    env: {},
  });
}

test("fully configured purchased channel with exact AI round-trip is ready", () => {
  const gate = evaluate();

  assert.equal(gate.status, "ready");
  assert.equal(gate.ready, true);
  assert.equal(gate.businessSetup.ready, true);
  assert.equal(gate.system.ready, true);
  assert.deepEqual(gate.channelContract.channels, ["whatsapp"]);
  assert.equal(gate.channels[0].ready, true);
  assert.equal(gate.channels[0].inboundVerified, true);
  assert.equal(gate.channels[0].aiReplyVerified, true);
  assert.equal(gate.blockers.length, 0);
  assert.equal(gate.testingRequired.length, 0);
});

test("required Client Setup completion blocks go-live even when technical readiness is green", () => {
  const completion = clientSetup(["whatsapp"], {
    requiredComplete: false,
    requiredCompletedCount: 5,
    incompleteRequired: [{
      id: "offerings",
      label: "Services",
      missing: ["Add at least one service"],
    }],
  });
  const gate = evaluate({ completion });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.ready, false);
  assert.equal(gate.blockers.some((item) => item.key === "business_setup"), true);
  assert.match(gate.blockers.find((item) => item.key === "business_setup").summary, /Services/);
});

test("missing purchased-channel contract fails closed", () => {
  const gate = evaluate({
    completion: clientSetup([], {
      channelContract: {
        configured: false,
        channels: [],
        error: null,
        source: null,
      },
    }),
  });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.blockers.some((item) => item.key === "purchased_channels" && item.status === "missing"), true);
  assert.equal(gate.channels.length, 0);
});

test("invalid purchased-channel contract fails closed with its configuration error", () => {
  const gate = evaluate({
    completion: clientSetup([], {
      channelContract: {
        configured: true,
        channels: [],
        error: "Unsupported PURCHASED_CHANNELS value: telegram",
        source: "environment",
      },
    }),
  });

  assert.equal(gate.status, "blocked");
  assert.match(gate.blockers.find((item) => item.key === "purchased_channels").summary, /telegram/);
});

test("configured purchased channel awaiting its first real conversation is needs_testing", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) =>
    item.key === "whatsapp_webhook"
      ? {
          ...item,
          configured: true,
          status: "warning",
          summary: "Configured. Waiting for the first valid signed webhook from Meta.",
        }
      : item
  );
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          status: "healthy",
          lastInboundAt: null,
          lastVerifiedAutomatedReplyAt: null,
          lastReadinessDeliveryFailureAt: null,
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "needs_testing");
  assert.equal(gate.ready, false);
  assert.equal(gate.blockers.length, 0);
  assert.equal(gate.testingRequired.some((item) => item.key === "whatsapp_webhook"), true);
  assert.equal(gate.testingRequired.some((item) => item.key === "whatsapp_round_trip_inbound"), true);
  assert.equal(gate.channels[0].inboundVerified, false);
});

test("latest inbound without a newer verified AI reply is needs_testing", () => {
  const overview = setupOverview();
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          lastInboundAt: "2026-09-09T10:05:00.000Z",
          lastVerifiedAutomatedReplyAt: "2026-09-09T10:04:59.000Z",
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "needs_testing");
  assert.equal(gate.testingRequired.some((item) => item.key === "whatsapp_round_trip_outbound"), true);
  assert.equal(gate.channels[0].aiReplyVerified, false);
});

test("a newer failed normal-AI delivery is blocked rather than needs_testing", () => {
  const overview = setupOverview();
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "whatsapp"
      ? {
          ...item,
          lastReadinessDeliveryFailureAt: "2026-09-09T10:00:05.000Z",
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.blockers.some((item) => item.key === "whatsapp_delivery_failure"), true);
  assert.equal(gate.channels[0].ready, false);
});

test("a technical channel warning that is not passive live-evidence waiting stays blocked", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) =>
    item.key === "whatsapp"
      ? {
          ...item,
          configured: true,
          status: "warning",
          summary: "Configured, but not checked yet.",
        }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "blocked");
  assert.equal(gate.blockers.some((item) => item.key === "whatsapp"), true);
});

test("unpurchased channel failures do not block the purchased channel contract", () => {
  const overview = setupOverview();
  overview.checks = overview.checks.map((item) =>
    item.key === "facebook"
      ? { ...item, configured: true, status: "error", summary: "Facebook token failed." }
      : item
  );
  overview.systemHealth.messaging = overview.systemHealth.messaging.map((item) =>
    item.channel === "facebook"
      ? { ...item, configured: true, status: "error", evidence: "Facebook is unhealthy." }
      : item
  );

  const gate = evaluate({ overview });

  assert.equal(gate.status, "ready");
  assert.equal(gate.ready, true);
  assert.deepEqual(gate.channels.map((item) => item.channel), ["whatsapp"]);
});

test("degraded but usable AI yields ready_with_warnings", () => {
  const overview = setupOverview();
  overview.systemHealth.ai = {
    status: "warning",
    summary: "One Gemini key is cooling down; another provider remains available.",
  };

  const gate = evaluate({ overview });

  assert.equal(gate.status, "ready_with_warnings");
  assert.equal(gate.ready, true);
  assert.equal(gate.warnings.some((item) => item.key === "system_health_ai"), true);
});
