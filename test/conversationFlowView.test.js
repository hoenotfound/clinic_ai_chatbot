const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

async function loadFlowBuilder() {
  const file = path.join(__dirname, "../portal-frontend/src/utils/conversationFlow.js");
  return import(pathToFileURL(file).href);
}

test("conversation flow is available from the portal for settings managers", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const page = read("portal-frontend/src/pages/ConversationFlow.jsx");

  assert.match(app, /import ConversationFlow from "\.\/pages\/ConversationFlow"/);
  assert.match(app, /path="\/conversation-flow"/);
  assert.match(app, /anyCapabilities=\{\["manage_settings"\]\}/);
  assert.match(sidebar, /to: "\/conversation-flow", label: "Conversation Flow"/);
  assert.match(sidebar, /icon: FlowIcon/);
  assert.match(page, /api\s*\.getConfig\(\)/);
  assert.match(page, /buildConversationFlow/);
  assert.match(page, /Synced with current settings/);
  assert.match(page, /Flexible, not scripted/);
  assert.match(page, /BranchRail/);
  assert.match(page, /AI does not force this order/);
  assert.match(page, /\/settings\?tab=aiBehavior/);
  assert.match(page, /\/settings\?tab=escalation/);
});

test("renovation flow reflects the industry profile and current configured knowledge", async () => {
  const { buildConversationFlow } = await loadFlowBuilder();
  const flow = buildConversationFlow({
    businessType: "home_renovation",
    terminology: {
      customerSingular: "customer",
      serviceSingular: "renovation service",
      servicePlural: "renovation services",
    },
    introMessage: "Hi! Thanks for reaching out about your renovation 😊",
    services: [
      { name: "Kitchen cabinets" },
      { name: "Wardrobes" },
    ],
    faqs: [{ q: "Do you cover Cheras?", a: "Yes" }],
    promotions: [{ name: "September package" }],
    conversion: {
      label: "site visit or quotation discussion",
      bookingReadyEnabled: false,
      staffConfirmationText: "The team will review the project details and confirm the next step.",
    },
    escalation: {
      outOfScopeTriggers: ["Customer asks for a human.", "Complaint or refund request."],
    },
  });

  assert.equal(flow.businessType, "home_renovation");
  assert.match(flow.knowledgeSummary, /2 renovation services/);
  assert.match(flow.knowledgeSummary, /1 FAQ/);
  assert.match(flow.knowledgeSummary, /1 promotion/);
  assert.equal(flow.knowledgeCounts.services, 2);
  assert.equal(flow.handoffCount, 2);
  assert.match(flow.flexibilityNote, /project, location and budget/i);
  assert.ok(flow.qualification.some((item) => item.label === "Budget if useful"));
  assert.ok(flow.qualification.some((item) => item.label === "Photos / floor plan"));

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Site visit / quotation discussion");
  assert.equal(conversion.branchLabel, "Ready to proceed");
  assert.match(conversion.summary, /site visit or quotation discussion/);

  const handoff = flow.outcomes.find((node) => node.id === "human-handoff");
  assert.equal(handoff.branchLabel, "Needs staff");
  assert.equal(handoff.meta, "2 handoff triggers");
  assert.deepEqual(handoff.details, ["Customer asks for a human.", "Complaint or refund request."]);
});

test("clinic flow explains booking-ready details without turning them into a rigid questionnaire", async () => {
  const { buildConversationFlow } = await loadFlowBuilder();
  const flow = buildConversationFlow({
    businessType: "aesthetic_clinic",
    terminology: {
      customerSingular: "patient",
      serviceSingular: "treatment",
      servicePlural: "treatments",
    },
    conversion: {
      label: "free consultation",
      bookingReadyEnabled: true,
      staffConfirmationText: "The team will check availability and follow up shortly.",
    },
  });

  assert.ok(flow.qualification.some((item) => item.label === "Preferred branch"));
  assert.ok(flow.qualification.some((item) => item.label === "Preferred day / time"));
  assert.match(flow.flexibilityNote, /treatment, branch and useful timing details/i);

  const intent = flow.mainNodes.find((node) => node.id === "understand-intent");
  assert.ok(intent.details.some((detail) => /does not force/i.test(detail)));

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Free consultation");
  assert.ok(conversion.details.some((detail) => /booking-ready logic/i.test(detail)));
});