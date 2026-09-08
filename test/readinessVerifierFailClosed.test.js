const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateReadiness,
} = require("../src/provisioning/readinessVerifier");

function businessProfile() {
  return {
    businessType: "home_renovation",
    selection: { locked: true },
    alignment: {
      pipeline: { businessType: "home_renovation" },
      conversion: { businessType: "home_renovation" },
      leadTemperature: { businessType: "home_renovation" },
      analytics: { businessType: "home_renovation", fallback: false },
    },
  };
}

function ready(key) {
  return { key, label: key, optional: false, configured: true, status: "ready", summary: `${key} ready` };
}

test("missing known core Setup Status result can never be mistaken for READY", () => {
  const report = evaluateReadiness({
    businessProfile: businessProfile(),
    checks: [
      ready("database"),
      ready("security"),
      ready("public_url"),
      ready("admin_account"),
      ready("ai"),
      // r2 intentionally omitted
      ready("whatsapp"),
      ready("whatsapp_webhook"),
    ],
  }, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["whatsapp"],
  });

  assert.equal(report.ready, false);
  const missing = report.blocking.find((item) => item.key === "r2");
  assert.equal(missing.status, "missing");
  assert.match(missing.summary, /was not returned/i);
});

test("missing required channel result can never be mistaken for READY", () => {
  const report = evaluateReadiness({
    businessProfile: businessProfile(),
    checks: [
      ready("database"),
      ready("security"),
      ready("public_url"),
      ready("admin_account"),
      ready("ai"),
      ready("r2"),
      ready("instagram"),
      // meta_webhook intentionally omitted
    ],
  }, {
    expectedIndustry: "home_renovation",
    requiredChannels: ["instagram"],
  });

  assert.equal(report.ready, false);
  assert.equal(report.blocking.some((item) => item.key === "meta_webhook" && item.status === "missing"), true);
});
