const QUALIFICATION_BY_INDUSTRY = {
  aesthetic_clinic: [
    {
      label: "Treatment or concern",
      detail: "Understand what the customer wants help with before guiding the next step.",
    },
    {
      label: "Preferred branch",
      detail: "Collect a branch when the customer is moving toward a consultation or appointment.",
    },
    {
      label: "Preferred day / time",
      detail: "Collect a useful timing preference before treating the conversation as booking-ready.",
    },
  ],
  home_renovation: [
    {
      label: "Project or service",
      detail: "Understand the renovation scope, such as kitchen cabinets, wardrobes, carpentry or a larger project.",
    },
    {
      label: "Property / project location",
      detail: "Collect the project area when it affects service coverage or the next sales step.",
    },
    {
      label: "Measurements if useful",
      detail: "Ask for rough dimensions only when they materially help the discussion.",
    },
    {
      label: "Budget if useful",
      detail: "Ask naturally and do not keep pushing if the customer is not ready to share it.",
    },
    {
      label: "Timeline",
      detail: "Understand the preferred renovation or move-in timing when it matters.",
    },
    {
      label: "Photos / floor plan",
      detail: "Request references only when they would help the team understand the project.",
    },
  ],
  generic: [
    {
      label: "Service or need",
      detail: "Understand what the customer is trying to achieve before asking for more details.",
    },
    {
      label: "Useful qualifying details",
      detail: "Collect only the information the team needs to answer accurately or continue the sale.",
    },
    {
      label: "Preferred next step",
      detail: "Guide a genuinely interested customer toward the configured business next step.",
    },
  ],
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

export function buildConversationFlow(config = {}) {
  const businessType = compact(config.businessType, "generic");
  const customerSingular = compact(config.terminology?.customerSingular, "customer");
  const serviceSingular = compact(config.terminology?.serviceSingular, "service");
  const servicePlural = compact(config.terminology?.servicePlural, `${serviceSingular}s`);
  const conversionLabel = compact(config.conversion?.label, "next step");
  const introMessage = compact(config.introMessage, "No fixed intro message configured.");
  const qualification = QUALIFICATION_BY_INDUSTRY[businessType] || QUALIFICATION_BY_INDUSTRY.generic;
  const services = list(config.services).filter((item) => compact(item?.name, ""));
  const faqs = list(config.faqs).filter((item) => compact(item?.q, "") && compact(item?.a, ""));
  const promotions = list(config.promotions).filter((item) => compact(item?.name, ""));
  const handoffTriggers = list(config.escalation?.outOfScopeTriggers)
    .map((item) => compact(item, ""))
    .filter(Boolean);

  const knowledgeSummary = [
    plural(services.length, serviceSingular, servicePlural),
    plural(faqs.length, "FAQ"),
    plural(promotions.length, "promotion"),
  ].join(" · ");

  const mainNodes = [
    {
      id: "customer-message",
      kind: "Customer",
      title: "Customer message",
      summary: `A new ${customerSingular} message enters the AI conversation flow.`,
      details: [
        "The same business rules are used across connected WhatsApp, Messenger and Instagram channels.",
        `Configured first-message intro: ${introMessage}`,
      ],
      settingsTab: "general",
    },
    {
      id: "understand-intent",
      kind: "AI",
      title: "Understand intent",
      summary: "The AI reads the latest message together with the conversation context before deciding what to do next.",
      details: [
        "Keeps the customer's language and conversation context in mind.",
        "Recognises questions, buying intent, useful details already supplied and requests for human help.",
        "Does not force the customer through a fixed questionnaire when the information is already available.",
      ],
      settingsTab: "aiBehavior",
    },
    {
      id: "answer-from-knowledge",
      kind: "Knowledge",
      title: "Answer what they asked",
      summary: "The AI answers from configured business information before asking for the next useful detail.",
      details: [
        knowledgeSummary,
        "Prices, services, policies and business facts must come from the configured information instead of being invented.",
      ],
      meta: knowledgeSummary,
      settingsTab: "services",
    },
    {
      id: "qualify-naturally",
      kind: "Qualification",
      title: "Qualify naturally",
      summary: `When useful, the AI collects the information needed to move the ${customerSingular} forward one question at a time.`,
      details: qualification.map((item) => `${item.label}: ${item.detail}`),
      meta: `${qualification.length} possible details`,
      settingsTab: "aiBehavior",
    },
    {
      id: "choose-next-path",
      kind: "Decision",
      title: "Choose the next path",
      summary: "The AI decides whether to keep helping, move toward the sales next step, or bring in a human.",
      details: [
        "Missing useful information → ask one sensible follow-up question.",
        `Clear intent to proceed → guide toward ${conversionLabel}.`,
        "Human judgment needed → stop automation and hand off.",
      ],
      settingsTab: "escalation",
    },
  ];

  const outcomes = [
    {
      id: "ask-next-question",
      kind: "Continue",
      title: "Ask one useful question",
      summary: "Collect only the missing detail that helps the conversation progress, then continue assisting.",
      details: [
        "Avoid repeating information the customer already provided.",
        "Answer new questions before returning to qualification.",
        "The conversation can loop naturally until there is enough information for a sensible next step.",
      ],
      meta: "Loops back into the conversation",
      settingsTab: "aiBehavior",
    },
    {
      id: "conversion-next-step",
      kind: "Conversion",
      title: titleCase(conversionLabel),
      summary: `Guide a genuinely interested ${customerSingular} toward ${conversionLabel} without claiming it is confirmed too early.`,
      details: [
        compact(
          config.conversion?.staffConfirmationText,
          "A staff member reviews the request and confirms the actual arrangement."
        ),
        config.conversion?.bookingReadyEnabled
          ? "Booking-ready logic only becomes true when the required scheduling details are actually present."
          : "The AI can guide the next step, but staff still confirms the real arrangement.",
      ],
      meta: "Human confirmation remains authoritative",
      settingsTab: "aiBehavior",
    },
    {
      id: "human-handoff",
      kind: "Human",
      title: "Human handoff",
      summary: "The AI stops trying to resolve the case when staff judgment or direct human help is required.",
      details: handoffTriggers.length > 0
        ? handoffTriggers
        : ["No handoff triggers are currently configured."],
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
    mainNodes,
    outcomes,
    allNodes: [...mainNodes, ...outcomes],
  };
}
