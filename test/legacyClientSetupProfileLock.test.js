const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { evaluateClientSetup } = require("../src/services/clientSetupService");

function configuredClinic() {
  return {
    businessType: "aesthetic_clinic",
    businessName: "Beleco Clinic",
    clinicName: "Beleco Clinic",
    businessDescription: "An aesthetics clinic in Malaysia",
    aiAssistantName: "Beleco Assistant",
    introMessage: "Hi, how can I help?",
    branches: [{ name: "KL", address: "Kuala Lumpur", phone: "" }],
    serviceAreas: [],
    hours: { general: "Mon-Sat 10am-7pm", closed: "" },
    contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
    services: [{ name: "Pico Laser", description: "", priceRange: "", duration: "" }],
    serviceAliases: [],
    faqs: [],
    promotions: [],
    tone: "Friendly and professional",
    messagingStyle: "Keep replies concise.",
    closingPlaybook: "Qualify the enquiry before suggesting the next step.",
    sop: "Follow the configured clinic process.",
    escalation: {
      handoffMessage: "A team member will assist you.",
      handoffNote: "",
      outOfScopeTriggers: ["Complaint"],
    },
    guardrails: ["Do not invent prices."],
  };
}

test("legacy configured clients without industrySetup are treated as locked and confirmed", () => {
  const status = evaluateClientSetup(configuredClinic());
  const business = status.sections.find((section) => section.id === "business");

  assert.equal(business.complete, true);
  assert.equal(business.missing.includes("Confirm the business profile"), false);
  assert.equal(status.requiredComplete, true);
});

test("fresh selectable deployments still require explicit profile confirmation", () => {
  const config = configuredClinic();
  config.industrySetup = {
    selectable: true,
    locked: false,
    source: "default",
  };

  const status = evaluateClientSetup(config);
  const business = status.sections.find((section) => section.id === "business");

  assert.equal(business.complete, false);
  assert.equal(business.missing.includes("Confirm the business profile"), true);
});

test("config API exposes normalized legacy lock state before Client Setup renders", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src/routes/config.js"), "utf8");

  assert.match(source, /normalizeIndustrySetup\(config\?\.industrySetup\)/);
  assert.match(source, /industrySetup:\s*normalizeIndustrySetup\(config\?\.industrySetup\)/);
  assert.match(source, /clientSetup:\s*evaluateClientSetup\(normalizedConfig\)/);
});
