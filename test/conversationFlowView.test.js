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

test("conversation flow explains the chatbot at first glance before showing details", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const page = read("portal-frontend/src/pages/ConversationFlow.jsx");

  assert.match(app, /import ConversationFlow from "\.\/pages\/ConversationFlow"/);
  assert.match(app, /path="\/conversation-flow"/);
  assert.match(app, /anyCapabilities=\{\["manage_settings"\]\}/);
  assert.match(sidebar, /to: "\/conversation-flow", label: "Conversation Flow"/);
  assert.match(page, /api\s*\.getConfig\(\)/);

  assert.match(page, /Understand in seconds how your AI handles a customer/);
  assert.match(page, /Your AI currently knows/);
  assert.match(page, /How your AI works/);
  assert.match(page, /Four things happen in every good conversation/);
  assert.match(page, /Understands the request/);
  assert.match(page, /Answers from your business info/);
  assert.match(page, /Asks only what's missing/);
  assert.match(page, /Chooses what happens next/);
  assert.match(page, /It remembers what the customer already said/);
  assert.match(page, /Not a fixed script/);

  assert.match(page, /See it in action/);
  assert.match(page, /Understands the question/);
  assert.match(page, /Keeps context/);
  assert.match(page, /actual reply adapts to the conversation/i);

  assert.match(page, /Every conversation ends up in one of three paths/);
  assert.match(page, /Keep helping/);
  assert.match(page, /Move to the next step/);
  assert.match(page, /Pass to your team/);
  assert.match(page, /Explore each step/);

  assert.match(page, /Example customer journey/);
  assert.match(page, /Choose a step to see an example chat/);
  assert.doesNotMatch(page, /real chat example/i);
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

test("renovation flow uses short client-friendly stages and configuration-aware examples", async () => {
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
    serviceAreas: ["Klang Valley"],
    faqs: [{ q: "Do you cover Klang Valley?", a: "Yes" }],
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
  assert.ok(customerMessage.examples.some((example) => /Klang Valley/i.test(example.customer)));

  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  assert.ok(qualification.examples.length >= 2);
  assert.match(qualification.shortNote, /illustrative/i);
  assert.match(qualification.shortNote, /saved AI Behavior instructions/i);
  assert.match(qualification.shortNote, /add, remove or skip questions/i);
  assert.ok(flow.qualification.some((item) => item.label === "Budget if useful"));
  assert.match(flow.flexibilityNote, /useful project details/i);
  assert.doesNotMatch(flow.flexibilityNote, /budget/i);

  const renovationExamples = JSON.stringify(flow.allNodes.flatMap((node) => node.examples || []));
  assert.match(renovationExamples, /Klang Valley/i);
  assert.doesNotMatch(renovationExamples, /Cheras/i);

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

test("clinic flow uses configured branch examples without making the flow rigid", async () => {
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
    branches: [{ name: "Mont Kiara", address: "", phone: "" }],
    conversion: {
      label: "free consultation",
      bookingReadyEnabled: true,
      staffConfirmationText: "The team will check availability and follow up shortly.",
    },
  });

  assert.ok(flow.qualification.some((item) => item.label === "Preferred branch"));
  assert.ok(flow.qualification.some((item) => item.label === "Preferred day / time"));
  assert.match(flow.flexibilityNote, /useful details needed to move forward/i);

  const answer = flow.mainNodes.find((node) => node.id === "answer-from-knowledge");
  assert.ok(answer.examples.some((example) => /treatment and pricing information we have/i.test(example.ai)));

  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  assert.ok(qualification.examples.some((example) => /Which branch/i.test(example.ai)));
  assert.ok(qualification.examples.some((example) => /Mont Kiara/i.test(example.customer)));
  assert.ok(qualification.examples.some((example) => /What day or time/i.test(example.ai)));

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Free consultation");
  assert.ok(conversion.examples.some((example) => /check availability/i.test(example.ai)));
  assert.ok(conversion.examples.some((example) => /Mont Kiara/i.test(example.customer)));

  const clinicExamples = JSON.stringify(flow.allNodes.flatMap((node) => node.examples || []));
  assert.doesNotMatch(clinicExamples, /PJ branch|Saturday afternoon/i);
});
