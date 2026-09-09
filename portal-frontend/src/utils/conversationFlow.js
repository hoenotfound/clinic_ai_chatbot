const QUALIFICATION_BY_INDUSTRY = {
  aesthetic_clinic: [
    { label: "Treatment or concern", detail: "Understand what the customer wants help with." },
    { label: "Preferred branch", detail: "Collect a branch when they are moving toward a consultation." },
    { label: "Preferred day / time", detail: "Collect a useful timing preference before treating the enquiry as booking-ready." },
  ],
  home_renovation: [
    { label: "Project or service", detail: "Understand what they want to renovate or build." },
    { label: "Property / project location", detail: "Collect the project area when it affects coverage or the next step." },
    { label: "Measurements if useful", detail: "Ask for rough dimensions only when they materially help." },
    { label: "Budget if useful", detail: "Ask naturally and do not keep pushing if they are not ready to share it." },
    { label: "Timeline", detail: "Understand the preferred renovation or move-in timing when it matters." },
    { label: "Photos / floor plan", detail: "Request references only when they help the team understand the project." },
  ],
  generic: [
    { label: "Service or need", detail: "Understand what the customer is trying to achieve." },
    { label: "Useful qualifying details", detail: "Collect only what the team needs to continue the sale accurately." },
    { label: "Preferred next step", detail: "Guide a genuinely interested customer toward the configured next step." },
  ],
};

const FLEXIBILITY_NOTE_BY_INDUSTRY = {
  aesthetic_clinic:
    "If a patient already gives the useful details needed to move forward, the AI can skip questions it no longer needs.",
  home_renovation:
    "If a customer already gives useful project details, the AI can skip questions it no longer needs.",
  generic:
    "If a customer already gives the details needed for the next step, the AI can skip questions it no longer needs.",
};

function list(value) {
  return Array.isArray(value) ? value : [];
}

function compact(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayConversionTitle(value) {
  const text = compact(value, "next step").replace(/\s+or\s+/gi, " / ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function firstServiceName(services, fallback) {
  return compact(services[0]?.name, fallback);
}

function chat(customer, ai) {
  return { customer, ai };
}

function exampleSet(businessType, context) {
  const { introMessage, conversionLabel, serviceName, locationName } = context;

  if (businessType === "home_renovation") {
    return {
      customerMessage: [
        chat(`Hi, I'm interested in ${serviceName}.`, introMessage),
        chat(`Can you help with a renovation project in ${locationName}?`, "Sure. What are you looking to renovate?"),
      ],
      understandIntent: [
        chat(`I want ${serviceName} for my condo.`, `Sure, I can help with ${serviceName}.`),
        chat("I want to redo my kitchen before moving in.", "Sure. I can help gather a few useful project details for the team."),
      ],
      answer: [
        chat("How much does it cost?", "The final quote depends on the project details. I can help collect the useful information first."),
        chat("Do you cover my area?", "Sure. Which area is your project in? I can help check whether it's within our coverage."),
      ],
      qualify: [
        chat(`I want ${serviceName}.`, "Sure. Do you have the approximate measurements or a photo of the space?"),
        chat(`The project is in ${locationName}.`, "Got it. What are you looking to renovate there?"),
      ],
      decision: [
        chat("I have the photos and project details ready.", `Great. I can guide this toward ${conversionLabel}.`),
        chat("I'm still comparing options.", "No problem. I can keep helping with your questions first."),
      ],
      continue: [
        chat("I don't know the measurements yet.", "That's okay. A clear photo or floor plan can still help the team understand the space."),
        chat("Can I ask about materials first?", "Of course. I'll answer that first, then we can continue with any useful project details."),
      ],
      conversion: [
        chat("Yes, I'd like to proceed.", `Great. I'll guide this toward ${conversionLabel}, and the team will confirm the actual arrangement.`),
        chat("I can send the photos now.", `Perfect. Send them over and the team can review the project for ${conversionLabel}.`),
      ],
      handoff: [
        chat("Can I speak to your staff directly?", "Sure. I'll get a team member to assist you directly."),
        chat("I need help with a complaint.", "I'll bring in a team member so they can review this properly."),
      ],
    };
  }

  if (businessType === "aesthetic_clinic") {
    return {
      customerMessage: [
        chat(`Hi, I'm interested in ${serviceName}.`, introMessage),
        chat("Can I know more about your treatments?", "Sure. What would you like help with?"),
      ],
      understandIntent: [
        chat(`I'm interested in ${serviceName}.`, `Sure. I can help with information about ${serviceName} and the next step.`),
        chat("I want something for facial lifting.", "Sure. What would you like to improve most?"),
      ],
      answer: [
        chat("How much is it?", "Sure. I can share the treatment and pricing information we have, and the team can confirm anything that needs checking."),
        chat("Is there a branch near me?", "Sure. Which area are you in? I can help narrow down the most convenient branch."),
      ],
      qualify: [
        chat("I'd like to book a consultation.", "Sure. Which branch is more convenient for you?"),
        chat(`${locationName} please.`, "Great. What day or time works best for you?"),
      ],
      decision: [
        chat(`${locationName}, weekday afternoon.`, `Great. That's enough to move toward ${conversionLabel}.`),
        chat("I'm just asking first.", "No problem. I'll keep answering your questions without pushing you to book."),
      ],
      continue: [
        chat("Not sure which branch yet.", "No problem. I can keep helping with your treatment questions first."),
        chat("Can you explain the treatment first?", "Of course. I'll answer that before asking for any booking details."),
      ],
      conversion: [
        chat(`${locationName}, weekday afternoon works.`, `Noted. The team will check availability and confirm the ${conversionLabel}.`),
        chat("Yes, please arrange it.", `Sure. I'll collect the needed details and the team will confirm the ${conversionLabel}.`),
      ],
      handoff: [
        chat("I want to speak to a staff member.", "Sure. I'll get a team member to assist you directly."),
        chat("I have a complaint about my previous visit.", "I'll bring in a team member so they can review this properly."),
      ],
    };
  }

  return {
    customerMessage: [
      chat(`Hi, I'd like to know more about ${serviceName}.`, introMessage),
      chat("Can you help me with your services?", "Sure. What would you like help with?"),
    ],
    understandIntent: [
      chat(`I'm interested in ${serviceName}.`, `Sure. I can help with ${serviceName} and the next step.`),
      chat("I'm comparing a few options.", "No problem. I can answer your questions first."),
    ],
    answer: [
      chat("How much does it cost?", "Sure. I can share the pricing information we have and let you know if the team needs to confirm anything."),
      chat("How does it work?", "Sure. I can explain the service and help with any questions you have."),
    ],
    qualify: [
      chat(`I'm interested in ${serviceName}.`, "Sure. May I know a little more about what you need?"),
      chat("I want to proceed soon.", "Great. I'll ask for only the details the team needs for the next step."),
    ],
    decision: [
      chat("Yes, I'd like to proceed.", `Great. I can guide this toward ${conversionLabel}.`),
      chat("I'm still thinking about it.", "No problem. I can keep helping with your questions first."),
    ],
    continue: [
      chat("I'm not sure yet.", "That's okay. What would you like to know before deciding?"),
      chat("Can I ask something else first?", "Of course. I'll answer that first."),
    ],
    conversion: [
      chat("Yes, let's proceed.", `Great. I'll guide this toward ${conversionLabel}, and the team will confirm the actual arrangement.`),
      chat("What happens next?", `I'll collect what's needed for ${conversionLabel} and the team will confirm it.`),
    ],
    handoff: [
      chat("Can I speak to someone?", "Sure. I'll get a team member to assist you directly."),
      chat("I need help with a complaint.", "I'll bring in a team member so they can review this properly."),
    ],
  };
}

export function buildConversationFlow(config = {}) {
  const businessType = compact(config.businessType, "generic");
  const customerSingular = compact(config.terminology?.customerSingular, "customer");
  const serviceSingular = compact(config.terminology?.serviceSingular, "service");
  const servicePlural = compact(config.terminology?.servicePlural, `${serviceSingular}s`);
  const conversionLabel = compact(config.conversion?.label, "next step");
  const introMessage = compact(config.introMessage, "Hi! Thanks for messaging us 😊");
  const qualification = QUALIFICATION_BY_INDUSTRY[businessType] || QUALIFICATION_BY_INDUSTRY.generic;
  const services = list(config.services).filter((item) => compact(item?.name, ""));
  const faqs = list(config.faqs).filter((item) => compact(item?.q, "") && compact(item?.a, ""));
  const promotions = list(config.promotions).filter((item) => compact(item?.name, ""));
  const branches = list(config.branches).filter((item) => compact(item?.name, ""));
  const serviceAreas = list(config.serviceAreas)
    .map((item) => compact(item, ""))
    .filter(Boolean);
  const handoffTriggers = list(config.escalation?.outOfScopeTriggers)
    .map((item) => compact(item, ""))
    .filter(Boolean);
  const serviceName = firstServiceName(
    services,
    businessType === "home_renovation" ? "a renovation project" : businessType === "aesthetic_clinic" ? "a treatment" : serviceSingular
  );
  const locationName = businessType === "aesthetic_clinic"
    ? compact(branches[0]?.name, "the branch near me")
    : businessType === "home_renovation"
      ? compact(serviceAreas[0], "a nearby area")
      : "my area";
  const examples = exampleSet(businessType, { introMessage, conversionLabel, serviceName, locationName });

  const knowledgeSummary = [
    plural(services.length, serviceSingular, servicePlural),
    plural(faqs.length, "FAQ"),
    plural(promotions.length, "promotion"),
  ].join(" · ");

  const mainNodes = [
    {
      id: "customer-message",
      kind: "Customer",
      title: "Customer asks",
      summary: `A new ${customerSingular} starts the conversation.`,
      examples: examples.customerMessage,
      shortNote: "The configured intro message is used on the first reply.",
      settingsTab: "general",
    },
    {
      id: "understand-intent",
      kind: "AI",
      title: "AI understands",
      summary: "Reads the message, language, context and details already given.",
      examples: examples.understandIntent,
      shortNote: "The AI keeps conversation context in mind instead of treating every message as a new enquiry.",
      settingsTab: "aiBehavior",
    },
    {
      id: "answer-from-knowledge",
      kind: "Knowledge",
      title: "AI answers",
      summary: "Answers the customer's question using configured business information.",
      examples: examples.answer,
      shortNote: "Prices, services, policies and business facts must come from configured information.",
      meta: knowledgeSummary,
      settingsTab: "services",
    },
    {
      id: "qualify-naturally",
      kind: "Qualification",
      title: "AI asks next",
      summary: "Collects only the next useful detail when it helps the conversation move forward.",
      examples: examples.qualify,
      shortNote: "This example is illustrative. Your saved AI Behavior instructions decide which details to ask for and can add, remove or skip questions.",
      meta: `Typical areas: ${qualification.map((item) => item.label).join(" · ")}`,
      settingsTab: "aiBehavior",
    },
    {
      id: "choose-next-path",
      kind: "Decision",
      title: "Ready to proceed?",
      summary: "Decides whether to keep helping, move toward the next sales step, or involve staff.",
      examples: examples.decision,
      shortNote: "The AI does not force a sale when the customer is still browsing or asking questions.",
      settingsTab: "escalation",
    },
  ];

  const outcomes = [
    {
      id: "ask-next-question",
      kind: "Continue",
      branchLabel: "Need more info",
      title: "Ask one more question",
      summary: "Ask only what is still useful, then continue the conversation.",
      examples: examples.continue,
      shortNote: "New customer questions are answered first before returning to qualification.",
      meta: "Conversation continues",
      settingsTab: "aiBehavior",
    },
    {
      id: "conversion-next-step",
      kind: "Conversion",
      branchLabel: "Ready to proceed",
      title: displayConversionTitle(conversionLabel),
      summary: `Guide an interested ${customerSingular} toward ${conversionLabel}.`,
      examples: examples.conversion,
      shortNote: compact(
        config.conversion?.staffConfirmationText,
        "A staff member reviews the request and confirms the actual arrangement."
      ),
      meta: "Staff confirmation remains authoritative",
      settingsTab: "aiBehavior",
    },
    {
      id: "human-handoff",
      kind: "Human",
      branchLabel: "Needs staff",
      title: "Human handoff",
      summary: "Stops automation when direct staff help or human judgment is needed.",
      examples: examples.handoff,
      shortNote: handoffTriggers.length
        ? `${plural(handoffTriggers.length, "handoff trigger")} are currently configured.`
        : "No handoff triggers are currently configured.",
      meta: plural(handoffTriggers.length, "handoff trigger"),
      settingsTab: "escalation",
    },
  ];

  return {
    businessType,
    industryLabel: titleCase(businessType),
    customerSingular,
    conversionLabel,
    qualification,
    knowledgeSummary,
    knowledgeCounts: {
      services: services.length,
      faqs: faqs.length,
      promotions: promotions.length,
    },
    handoffCount: handoffTriggers.length,
    flexibilityNote: FLEXIBILITY_NOTE_BY_INDUSTRY[businessType] || FLEXIBILITY_NOTE_BY_INDUSTRY.generic,
    mainNodes,
    outcomes,
    allNodes: [...mainNodes, ...outcomes],
  };
}
