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

test("conversation flow presents a chat-first client view", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const page = read("portal-frontend/src/pages/ConversationFlow.jsx");

  assert.match(app, /import ConversationFlow from "\.\/pages\/ConversationFlow"/);
  assert.match(app, /path="\/conversation-flow"/);
  assert.match(app, /anyCapabilities=\{\["manage_settings"\]\}/);
  assert.match(sidebar, /to: "\/conversation-flow", label: "Conversation Flow"/);
  assert.match(page, /api\s*\.getConfig\(\)/);
  assert.match(page, /See how your AI replies to enquiries/);
  assert.match(page, /Example chat/);
  assert.match(page, /Show another example/);
  assert.match(page, /ChatExample/);
  assert.match(page, /Customer/);
  assert.match(page, />AI</);
  assert.match(page, /Why this happens/);
  assert.match(page, /Adapts to each conversation/);
  assert.match(page, /Examples illustrate typical behaviour/);
  assert.match(page, /matchMedia\("\(max-width: 1279px\)"\)/);
  assert.match(page, /scrollIntoView\(\{ behavior: "smooth", block: "start" \}\)/);
  assert.match(page, /\/settings\?tab=aiBehavior/);
  assert.match(page, /\/settings\?tab=escalation/);
});

test("renovation flow uses short client-friendly stages and realistic examples", async () => {
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
    closingPlaybook: "Do not ask for budget. Qualify only on scope and location.",
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
  assert.equal(flow.knowledgeCounts.services, 2);
  assert.equal(flow.knowledgeCounts.faqs, 1);
  assert.equal(flow.knowledgeCounts.promotions, 1);
  assert.equal(flow.handoffCount, 2);

  assert.deepEqual(
    flow.mainNodes.map((node) => node.title),
    ["Customer asks", "AI understands", "AI answers", "AI asks next", "Ready to proceed?"]
  );

  const customerMessage = flow.mainNodes.find((node) => node.id === "customer-message");
  assert.equal(customerMessage.examples[0].customer, "Hi, I'm interested in Kitchen cabinets.");
  assert.equal(customerMessage.examples[0].ai, "Hi! Thanks for reaching out about your renovation 😊");

  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  assert.ok(qualification.examples.length >= 2);
  assert.match(qualification.shortNote, /typical industry qualification/i);
  assert.match(qualification.shortNote, /AI Behavior instructions/i);
  assert.ok(flow.qualification.some((item) => item.label === "Budget if useful"));

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Site visit / quotation discussion");
  assert.equal(conversion.branchLabel, "Ready to proceed");
  assert.ok(conversion.examples.some((example) => /site visit or quotation discussion/i.test(example.ai)));

  const handoff = flow.outcomes.find((node) => node.id === "human-handoff");
  assert.equal(handoff.branchLabel, "Needs staff");
  assert.equal(handoff.meta, "2 handoff triggers");
  assert.ok(
    handoff.examples.some((example) =>
      /(team member|staff).*(assist|help).*directly/i.test(example.ai)
    )
  );
});

test("clinic flow examples show branch and timing without making the flow rigid", async () => {
  const { buildConversationFlow } = await loadFlowBuilder();
  const flow = buildConversationFlow({
    businessType: "aesthetic_clinic",
    introMessage: "Hi! Thanks for messaging our clinic 😊",
    terminology: {
      customerSingular: "patient",
      serviceSingular: "treatment",
      servicePlural: "treatments",
    },
    services: [{ name: "HIFU" }],
    conversion: {
      label: "free consultation",
      bookingReadyEnabled: true,
      staffConfirmationText: "The team will check availability and follow up shortly.",
    },
  });

  assert.ok(flow.qualification.some((item) => item.label === "Preferred branch"));
  assert.ok(flow.qualification.some((item) => item.label === "Preferred day / time"));
  assert.match(flow.flexibilityNote, /treatment, branch and timing details/i);

  const answer = flow.mainNodes.find((node) => node.id === "answer-from-knowledge");
  assert.ok(answer.examples.some((example) => /treatment and pricing information we have/i.test(example.ai)));

  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  assert.ok(qualification.examples.some((example) => /Which branch/i.test(example.ai)));
  assert.ok(qualification.examples.some((example) => /What day or time/i.test(example.ai)));

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Free consultation");
  assert.ok(conversion.examples.some((example) => /check availability/i.test(example.ai)));
});
