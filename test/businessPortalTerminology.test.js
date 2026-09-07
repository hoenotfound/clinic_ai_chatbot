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
  assert.equal(ui.locationLabel, "Branch");
  assert.equal(ui.servicesLabel, "Treatments");
  assert.equal(ui.serviceInterestLabel, "Treatment interest");
  assert.equal(ui.insightsInterestLabel, "Treatment / Interest");
  assert.equal(ui.preferredLocationLabel, "Preferred Branch");
  assert.equal(ui.conversionLabel, "Appointment");
  assert.equal(ui.conversionStatusLabel, "Appointment status");
  assert.equal(ui.staffLocationLabel, "Sales branch");
  assert.equal(ui.conversionStatusOptions.find(([value]) => value === "visited")[1], "Visited clinic");
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
  assert.equal(ui.locationLabel, "Location");
  assert.equal(ui.servicesLabel, "Renovation Services");
  assert.equal(ui.serviceInterestLabel, "Service / project interest");
  assert.equal(ui.insightsInterestLabel, "Service / Project Interest");
  assert.equal(ui.preferredLocationLabel, "Preferred Location");
  assert.equal(ui.conversionLabel, "Next step");
  assert.equal(ui.conversionStatusLabel, "Next-step status");
  assert.equal(ui.staffLocationLabel, "Sales location");
  assert.equal(ui.noFixedLocationLabel, "No fixed location");
  assert.equal(ui.conversionStatusOptions.find(([value]) => value === "set")[1], "Next step set");
  assert.equal(ui.conversionStatusOptions.find(([value]) => value === "visited")[1], "Visited / completed");
  assert.equal(tabs.find((tab) => tab.id === "branches").label, "Locations");
  assert.equal(tabs.find((tab) => tab.id === "services").label, "Renovation Services");
});

test("generic and unknown profiles fail toward neutral business wording", async () => {
  const { getBusinessTerminology } = await loadTerminologyModule();

  assert.equal(getBusinessTerminology({ businessType: "generic" }).businessNameLabel, "Business name");
  assert.equal(getBusinessTerminology({ businessType: "future_industry" }).businessNoun, "business");
  assert.equal(getBusinessTerminology({ businessType: "future_industry" }).conversionLabel, "Next step");
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

test("CRM surfaces consume the shared business terminology instead of duplicating clinic labels", () => {
  const root = path.join(__dirname, "..", "portal-frontend", "src");
  const files = [
    "components/pipeline/LeadCard.jsx",
    "components/pipeline/AddLeadModal.jsx",
    "components/ContactInsights.jsx",
    "pages/Contacts.jsx",
  ];

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(source, /getBusinessTerminology/);
    assert.match(source, /useBusinessConfig/);
  }

  const contacts = fs.readFileSync(path.join(root, "pages/Contacts.jsx"), "utf8");
  const addLead = fs.readFileSync(path.join(root, "components/pipeline/AddLeadModal.jsx"), "utf8");
  const insights = fs.readFileSync(path.join(root, "components/ContactInsights.jsx"), "utf8");

  assert.doesNotMatch(contacts, /about this patient|add a patient|this patient's|identifies the patient/i);
  assert.doesNotMatch(addLead, /Add the patient from Contacts first|Clinic Settings|Treatment interest/);
  assert.doesNotMatch(insights, /label="Treatment \/ Interest"|label="Preferred Branch"|label="Appointment"/);
});
