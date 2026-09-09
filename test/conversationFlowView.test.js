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

test("conversation flow uses one compact expandable journey without a separate detail panel", () => {
  const app = read("portal-frontend/src/App.jsx");
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const page = read("portal-frontend/src/pages/ConversationFlow.jsx");

  assert.match(app, /import ConversationFlow from "\.\/pages\/ConversationFlow"/);
  assert.match(app, /path="\/conversation-flow"/);
  assert.match(app, /anyCapabilities=\{\["manage_settings"\]\}/);
  assert.match(sidebar, /to: "\/conversation-flow", label: "Conversation Flow"/);
  assert.match(page, /api\s*\.getConfig\(\)/);
  assert.match(page, /See how your AI answers customers and guides interested leads toward the next step/);
  assert.match(page, /How the AI guides a lead forward/);
  assert.match(page, /Select a step to see how it answers, qualifies and moves the conversation forward/);
  assert.match(page, /useState\("answer-from-knowledge"\)/);
  assert.match(page, /currentId === id \? null : id/);
  assert.doesNotMatch(page, /setExampleIndex\(0\)/);
  assert.match(page, /AI replies & guides/);
  assert.match(page, /AI moves conversation forward/);
  assert.match(page, /AI decides next step/);
  assert.match(page, /Keep chatting/);
  assert.match(page, /Ready to proceed/);
  assert.match(page, /Human handoff/);
  assert.match(page, /InlineDetail/);
  assert.match(page, />Example</);
  assert.match(page, /Another example/);
  assert.match(page, /ChatExample/);
  assert.match(page, /Customer/);
  assert.match(page, />AI</);
  assert.match(page, /Why this step:/);
  assert.match(page, /Adapts to each conversation/);
  assert.match(page, /Examples illustrate typical behaviour/);
  assert.match(page, /Edit in \{settingsLabel/);
  assert.match(page, /aria-expanded=\{selected\}/);
  assert.match(page, /selected && \(/);
  assert.match(page, /selectedIsOutcome && \(/);
  assert.match(page, /md:hidden/);
  assert.match(page, /hidden w-full max-w-2xl md:block/);
  assert.match(page, /max-w-\[88%\]/);
  assert.doesNotMatch(page, /<aside/);
  assert.doesNotMatch(page, /detailRef/);
  assert.doesNotMatch(page, /matchMedia/);
  assert.doesNotMatch(page, /scrollIntoView/);
  assert.doesNotMatch(page, /xl:grid-cols/);
  assert.doesNotMatch(page, /real chat example/i);
});

test("renovation flow uses connected client-friendly journeys and configuration-aware examples", async () => {
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
  assert.ok(flow.mainNodes.every((node) => node.examples.length === 2));

  const customerMessage = flow.mainNodes.find((node) => node.id === "customer-message");
  const understand = flow.mainNodes.find((node) => node.id === "understand-intent");
  const answer = flow.mainNodes.find((node) => node.id === "answer-from-knowledge");
  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  const decision = flow.mainNodes.find((node) => node.id === "choose-next-path");

  assert.equal(customerMessage.examples[0].customer, "Hi, I'm interested in Kitchen cabinets for my condo.");
  assert.match(customerMessage.examples[0].ai, /^Hi! Thanks for reaching out about your renovation 😊/);
  assert.match(customerMessage.examples[0].ai, /Which area is the project in/i);
  assert.match(customerMessage.shortNote, /added at the start of the first AI reply/i);

  assert.match(understand.examples[0].customer, /Klang Valley/i);
  assert.match(understand.examples[0].ai, /Kitchen cabinets/i);
  assert.match(understand.examples[0].ai, /Klang Valley/i);
  assert.match(understand.examples[0].ai, /12ft/i);
  assert.match(answer.examples[0].customer, /floor plan.*how much/i);
  assert.match(answer.examples[0].ai, /layout, materials and measurements/i);
  assert.match(qualification.examples[0].customer, /send the floor plan/i);
  assert.match(qualification.examples[0].ai, /quotation.*site visit/i);
  assert.match(decision.examples[0].customer, /Quotation first/i);
  assert.match(decision.examples[0].ai, /site visit or quotation discussion/i);

  assert.match(customerMessage.examples[1].customer, /comparing options/i);
  assert.match(understand.examples[1].customer, /comparing materials and price/i);
  assert.match(decision.examples[1].ai, /without pushing you to proceed/i);

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

test("clinic flow uses a connected booking journey without making the flow rigid", async () => {
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

  const customerMessage = flow.mainNodes.find((node) => node.id === "customer-message");
  const understand = flow.mainNodes.find((node) => node.id === "understand-intent");
  const answer = flow.mainNodes.find((node) => node.id === "answer-from-knowledge");
  const qualification = flow.mainNodes.find((node) => node.id === "qualify-naturally");
  const decision = flow.mainNodes.find((node) => node.id === "choose-next-path");

  assert.match(customerMessage.examples[0].ai, /^Hi! Thanks for messaging our clinic 😊/);
  assert.match(customerMessage.examples[0].ai, /HIFU/i);
  assert.match(understand.examples[0].customer, /price.*book a consultation/i);
  assert.ok(answer.examples.some((example) => /configured treatment and pricing information/i.test(example.ai)));
  assert.match(qualification.examples[0].customer, /Mont Kiara/i);
  assert.match(qualification.examples[0].ai, /What day or time/i);
  assert.match(decision.examples[0].customer, /Weekday afternoon/i);
  assert.match(decision.examples[0].ai, /Mont Kiara/i);
  assert.match(decision.examples[0].ai, /weekday afternoon/i);
  assert.match(decision.examples[0].ai, /free consultation/i);

  assert.match(customerMessage.examples[1].customer, /know more about HIFU/i);
  assert.match(understand.examples[1].customer, /comparing treatments/i);
  assert.match(decision.examples[1].ai, /without pushing you to book/i);

  const conversion = flow.outcomes.find((node) => node.id === "conversion-next-step");
  assert.equal(conversion.title, "Free consultation");
  assert.ok(conversion.examples.some((example) => /check availability/i.test(example.ai)));
  assert.ok(conversion.examples.some((example) => /Mont Kiara/i.test(example.customer)));

  const clinicExamples = JSON.stringify(flow.allNodes.flatMap((node) => node.examples || []));
  assert.doesNotMatch(clinicExamples, /PJ branch|Saturday afternoon/i);
});