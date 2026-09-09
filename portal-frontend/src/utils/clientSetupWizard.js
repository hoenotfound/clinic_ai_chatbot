const PLACEHOLDER_BUSINESS_NAMES = new Set([
  "Your Clinic",
  "Your Renovation Business",
  "Your Business",
]);

export const CLIENT_SETUP_STORAGE_VERSION = 1;
export const CLIENT_SETUP_CONFIG_STEPS = Object.freeze([
  "business",
  "locations",
  "operating",
  "offerings",
  "knowledge",
  "aiBehavior",
  "handoff",
  "promotions",
]);
export const CLIENT_SETUP_SCREENS = Object.freeze([
  "welcome",
  ...CLIENT_SETUP_CONFIG_STEPS,
  "review",
  "goLive",
]);

function text(value) {
  return String(value || "").trim();
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function hasNamedEntries(items, key = "name") {
  return Array.isArray(items) && items.some((item) => text(item?.[key]));
}

function openingHoursConfigured(config) {
  const value = text(config?.hours?.general);
  return Boolean(value) && !/not configured yet/i.test(value);
}

function profileConfirmed(config) {
  const setup = config?.industrySetup;
  return setup?.locked === true && setup?.selectable !== true;
}

function industryLabel(config) {
  switch (config?.businessType) {
    case "aesthetic_clinic":
      return "Aesthetic Clinic";
    case "home_renovation":
      return "Home Renovation";
    default:
      return "General Business";
  }
}

function locationLabel(config) {
  if (config?.businessType === "aesthetic_clinic") return "Branches";
  if (config?.businessType === "home_renovation") return "Service areas / locations";
  return "Locations";
}

function locationsRequired(config) {
  return config?.businessType === "aesthetic_clinic";
}

function contactConfigured(config) {
  const contact = config?.contact || {};
  return [contact.whatsapp, contact.instagram, contact.facebook, contact.tiktok].some((value) => text(value));
}

export function isPlaceholderBusinessName(value) {
  return PLACEHOLDER_BUSINESS_NAMES.has(text(value));
}

export function getClientSetupCompletion(config = {}) {
  const locationRequired = locationsRequired(config);
  const businessMissing = [];
  if (!profileConfirmed(config)) businessMissing.push("Confirm the business profile");
  if (!text(config.businessName || config.clinicName) || isPlaceholderBusinessName(config.businessName || config.clinicName)) {
    businessMissing.push("Enter the real business name");
  }
  if (!text(config.aiAssistantName)) businessMissing.push("Enter an AI assistant name");
  if (!text(config.introMessage)) businessMissing.push("Enter an intro message");

  const locationMissing = locationRequired && !hasNamedEntries(config.branches)
    ? ["Add at least one branch"]
    : [];

  const operatingMissing = openingHoursConfigured(config)
    ? []
    : ["Enter real operating hours"];

  const offeringsMissing = hasNamedEntries(config.services)
    ? []
    : [`Add at least one ${config?.businessType === "aesthetic_clinic" ? "treatment" : "service"}`];

  const aiMissing = [];
  if (!text(config.tone)) aiMissing.push("Set the AI tone");
  if (!text(config.messagingStyle)) aiMissing.push("Set the texting style");
  if (!text(config.closingPlaybook)) aiMissing.push("Set the sales/conversation playbook");
  if (!text(config.sop)) aiMissing.push("Set the operating instructions");

  const handoffMissing = [];
  if (!text(config?.escalation?.handoffMessage)) handoffMissing.push("Set the customer handoff message");
  if (!Array.isArray(config?.escalation?.outOfScopeTriggers) || !config.escalation.outOfScopeTriggers.some((item) => text(item))) {
    handoffMissing.push("Add at least one handoff trigger");
  }
  if (!Array.isArray(config.guardrails) || !config.guardrails.some((item) => text(item))) {
    handoffMissing.push("Keep at least one AI guardrail");
  }

  const sections = [
    {
      id: "business",
      label: "Business",
      required: true,
      complete: businessMissing.length === 0,
      missing: businessMissing,
      note: `${industryLabel(config)} profile`,
    },
    {
      id: "locations",
      label: locationLabel(config),
      required: locationRequired,
      complete: locationMissing.length === 0,
      missing: locationMissing,
      note: locationRequired ? "Required for clinic routing and booking context" : "Optional if the business has no fixed location",
    },
    {
      id: "operating",
      label: "Hours & contact",
      required: true,
      complete: operatingMissing.length === 0,
      missing: operatingMissing,
      note: contactConfigured(config) ? "Contact channel saved" : "Add at least one contact channel when available",
    },
    {
      id: "offerings",
      label: config?.businessType === "aesthetic_clinic" ? "Treatments" : "Services",
      required: true,
      complete: offeringsMissing.length === 0,
      missing: offeringsMissing,
      note: Array.isArray(config.serviceAliases) && config.serviceAliases.length > 0
        ? "Customer terms are mapped"
        : "Service terms are optional",
    },
    {
      id: "knowledge",
      label: "FAQs",
      required: false,
      complete: true,
      missing: [],
      note: hasNamedEntries(config.faqs, "q") ? "FAQs added" : "Optional, can be added later",
    },
    {
      id: "aiBehavior",
      label: "AI behaviour",
      required: true,
      complete: aiMissing.length === 0,
      missing: aiMissing,
      note: "Uses the same instructions as Settings",
    },
    {
      id: "handoff",
      label: "Human handoff",
      required: true,
      complete: handoffMissing.length === 0,
      missing: handoffMissing,
      note: "Defines when the AI should stop and involve staff",
    },
    {
      id: "promotions",
      label: "Promotions",
      required: false,
      complete: true,
      missing: [],
      note: hasNamedEntries(config.promotions) ? "Promotion configured" : "Optional, can be added later",
    },
  ];

  const completedCount = sections.filter((section) => section.complete).length;
  const incompleteRequired = sections.filter((section) => section.required && !section.complete);

  return {
    sections,
    completedCount,
    total: sections.length,
    requiredComplete: incompleteRequired.length === 0,
    incompleteRequired,
  };
}

export function isFreshClientSetupCandidate(config = {}) {
  const source = text(config?.industrySetup?.source);
  if (!profileConfirmed(config)) return false;
  if (!["environment", "setup_status"].includes(source)) return false;
  if (!isPlaceholderBusinessName(config.businessName || config.clinicName)) return false;
  return !getClientSetupCompletion(config).requiredComplete;
}

export function getClientSetupStorageKey(username, businessType) {
  const safeUser = text(username) || "unknown";
  const safeType = text(businessType) || "generic";
  return `da-chatbot:client-setup:v${CLIENT_SETUP_STORAGE_VERSION}:${safeUser}:${safeType}`;
}

export function readClientSetupProgress(username, businessType, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(getClientSetupStorageKey(username, businessType));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CLIENT_SETUP_STORAGE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeClientSetupProgress(username, businessType, updates, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const current = readClientSetupProgress(username, businessType, storage) || {};
    const next = {
      version: CLIENT_SETUP_STORAGE_VERSION,
      started: true,
      dismissed: false,
      completed: false,
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    storage.setItem(getClientSetupStorageKey(username, businessType), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function validClientSetupScreen(value) {
  return CLIENT_SETUP_SCREENS.includes(value) ? value : "welcome";
}

export function shouldAutoStartClientSetup(config, progress) {
  if (getClientSetupCompletion(config).requiredComplete) return false;
  if (progress?.completed || progress?.dismissed) return false;
  if (progress?.started) return true;
  return isFreshClientSetupCandidate(config);
}
