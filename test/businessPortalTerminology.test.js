const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadTerminologyModule() {
  const modulePath = path.join(
    __dirname,
    "..",
    "portal-frontend",
    "src",
    "utils",
    "businessTerminology.js"
  );
  return import(pathToFileURL(modulePath).href);
}

test("aesthetic clinic portal keeps clinic-specific labels", async () => {
  const { getBusinessTerminology, getSettingsTabs } = await loadTerminologyModule();
  const config = {
    businessType: "aesthetic_clinic",
    terminology: { customerSingular: "patient", customerPlural: "patients" },
  };

  const ui = getBusinessTerminology(config);
  const tabs = getSettingsTabs(config);

  assert.equal(ui.businessNameLabel, "Clinic name");
  assert.equal(ui.businessNoun, "clinic");
  assert.equal(ui.customerSingular, "patient");
  assert.equal(ui.locationsLabel, "Branches");
  assert.equal(ui.servicesLabel, "Treatments");
  assert.equal(tabs.find((tab) => tab.id === "branches").label, "Branches");
  assert.equal(tabs.find((tab) => tab.id === "services").label, "Treatments");
});

test("renovation portal does not expose clinic terminology", async () => {
  const { getBusinessTerminology, getSettingsTabs } = await loadTerminologyModule();
  const config = {
    businessType: "home_renovation",
    terminology: { customerSingular: "customer", customerPlural: "customers" },
  };

  const ui = getBusinessTerminology(config);
  const tabs = getSettingsTabs(config);

  assert.equal(ui.businessNameLabel, "Business name");
  assert.equal(ui.businessNoun, "business");
  assert.equal(ui.customerSingular, "customer");
  assert.equal(ui.locationsLabel, "Locations");
  assert.equal(ui.servicesLabel, "Renovation Services");
  assert.equal(tabs.find((tab) => tab.id === "branches").label, "Locations");
  assert.equal(tabs.find((tab) => tab.id === "services").label, "Renovation Services");
});

test("generic and unknown profiles fail toward neutral business wording", async () => {
  const { getBusinessTerminology } = await loadTerminologyModule();

  assert.equal(getBusinessTerminology({ businessType: "generic" }).businessNameLabel, "Business name");
  assert.equal(getBusinessTerminology({ businessType: "future_industry" }).businessNoun, "business");
  assert.equal(getBusinessTerminology({}).customerSingular, "customer");
});

test("portal shell no longer hard-codes clinic-only global copy", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "portal-frontend", "index.html"), "utf8");
  const permissions = fs.readFileSync(path.join(root, "src", "utils", "permissions.js"), "utf8");

  assert.doesNotMatch(html, /<title>Clinic Portal<\/title>/);
  assert.match(html, /<title>AI Chatbot Portal<\/title>/);
  assert.doesNotMatch(permissions, /clinic-wide/);
  assert.doesNotMatch(permissions, /Manage clinic & AI settings/);
  assert.match(permissions, /Manage business & AI settings/);
});
