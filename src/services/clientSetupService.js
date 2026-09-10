const { getIndustryProfile } = require("../config/industryProfiles");
const { normalizeIndustrySetup } = require("../config/industrySetup");

const PLACEHOLDER_BUSINESS_NAMES = new Set([
  "Your Clinic",
  "Your Renovation Business",
  "Your Business",
]);
const SUPPORTED_PURCHASED_CHANNELS = new Set(["whatsapp", "facebook", "instagram"]);

function text(value) {
  return String(value || "").trim();
}

function hasNamedEntries(items, key = "name") {
  return Array.isArray(items) && items.some((item) => text(item?.[key]));
}

function hasStringEntries(items) {
  return Array.isArray(items) && items.some((item) => text(item));
}

function openingHoursConfigured(config) {
  const value = text(config?.hours?.general);
  return Boolean(value) && !/not configured yet/i.test(value);
}

function profileConfirmed(config) {
  const setup = normalizeIndustrySetup(config?.industrySetup);
  return setup.locked === true && setup.selectable !== true;
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
  if (config?.businessType === "home_renovation") return "Locations & service areas";
  return "Locations";
}

function locationsRequired(config) {
  return config?.businessType === "aesthetic_clinic";
}

function contactConfigured(config) {
  const contact = config?.contact || {};
  return [contact.whatsapp, contact.instagram, contact.facebook, contact.tiktok].some((value) => text(value));
}

function isPlaceholderBusinessName(value) {
  return PLACEHOLDER_BUSINESS_NAMES.has(text(value));
}

function protectedGuardrails(config) {
  const activeGuardrails = new Set(
    (Array.isArray(config?.guardrails) ? config.guardrails : [])
      .map((item) => text(item))
      .filter(Boolean),
  );

  try {
    return (getIndustryProfile(config?.businessType || "generic").guardrails || [])
      .map((item) => text(item))
      .filter((item) => item && activeGuardrails.has(item));
  } catch {
    return [];
  }
}

function purchasedChannelContract(env = process.env) {
  const raw = text(env?.PURCHASED_CHANNELS);
  if (!raw) {
    return {
      configured: false,
      channels: [],
      error: null,
      source: null,
    };
  }

  const channels = [];
  for (const item of raw.split(",")) {
    const channel = text(item).toLowerCase();
    if (!channel) continue;
    if (!SUPPORTED_PURCHASED_CHANNELS.has(channel)) {
      return {
        configured: true,
        channels: [],
        error: `Unsupported PURCHASED_CHANNELS value: ${channel}`,
        source: "environment",
      };
    }
    if (!channels.includes(channel)) channels.push(channel);
  }

  return {
    configured: true,
    channels,
    error: null,
    source: "environment",
  };
}

function sectionState({ required, configured, missing }) {
  if (required) return missing.length === 0 ? "ready" : "needs_attention";
  return configured ? "configured" : "optional";
}

function buildSection({ id, label, required, configured, missing = [], note = "" }) {
  const complete = required ? missing.length === 0 : configured;
  return {
    id,
    label,
    required,
    configured,
    complete,
    state: sectionState({ required, configured, missing }),
    missing,
    note,
  };
}

function evaluateClientSetup(config = {}, env = process.env) {
  const locationRequired = locationsRequired(config);
  const branchesConfigured = hasNamedEntries(config.branches);
  const serviceAreasConfigured = hasStringEntries(config.serviceAreas);

  const businessMissing = [];
  if (!profileConfirmed(config)) businessMissing.push("Confirm the business profile");
  if (!text(config.businessName || config.clinicName) || isPlaceholderBusinessName(config.businessName || config.clinicName)) {
    businessMissing.push("Enter the real business name");
  }
  if (!text(config.businessDescription)) businessMissing.push("Describe what the business does");
  if (!text(config.aiAssistantName)) businessMissing.push("Enter an AI assistant name");
  if (!text(config.introMessage)) businessMissing.push("Enter an intro message");

  const clinicBranches = Array.isArray(config.branches) ? config.branches : [];
  const clinicBranchMissingAddress = config?.businessType === "aesthetic_clinic"
    && clinicBranches.some((branch) => text(branch?.name) && !text(branch?.address));
  const locationMissing = locationRequired
    ? [
        ...(!branchesConfigured ? ["Add at least one branch"] : []),
        ...(clinicBranchMissingAddress ? ["Add an address for every clinic branch"] : []),
      ]
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

  const locationConfigured = config?.businessType === "home_renovation"
    ? branchesConfigured || serviceAreasConfigured
    : branchesConfigured;
  const knowledgeConfigured = hasNamedEntries(config.faqs, "q");
  const promotionsConfigured = hasNamedEntries(config.promotions);

  const sections = [
    buildSection({
      id: "business",
      label: "Business",
      required: true,
      configured: businessMissing.length === 0,
      missing: businessMissing,
      note: `${industryLabel(config)} profile`,
    }),
    buildSection({
      id: "locations",
      label: locationLabel(config),
      required: locationRequired,
      configured: locationConfigured,
      missing: locationMissing,
      note: locationRequired
        ? "Required for clinic routing and booking context"
        : config?.businessType === "home_renovation"
          ? "Showrooms/branches stay separate from customer project coverage areas"
          : "Optional if the business has no fixed location",
    }),
    buildSection({
      id: "operating",
      label: "Hours & contact",
      required: true,
      configured: openingHoursConfigured(config),
      missing: operatingMissing,
      note: contactConfigured(config) ? "Contact channel saved" : "Add at least one contact channel when available",
    }),
    buildSection({
      id: "offerings",
      label: config?.businessType === "aesthetic_clinic" ? "Treatments" : "Services",
      required: true,
      configured: hasNamedEntries(config.services),
      missing: offeringsMissing,
      note: Array.isArray(config.serviceAliases) && config.serviceAliases.length > 0
        ? "Customer terms are mapped"
        : "Service terms are optional",
    }),
    buildSection({
      id: "knowledge",
      label: "FAQs",
      required: false,
      configured: knowledgeConfigured,
      note: knowledgeConfigured ? "FAQs added" : "Optional, can be added later",
    }),
    buildSection({
      id: "aiBehavior",
      label: "AI behaviour",
      required: true,
      configured: aiMissing.length === 0,
      missing: aiMissing,
      note: "Uses the same live instructions as Settings",
    }),
    buildSection({
      id: "handoff",
      label: "Human handoff",
      required: true,
      configured: handoffMissing.length === 0,
      missing: handoffMissing,
      note: "Defines when the AI should stop and involve staff",
    }),
    buildSection({
      id: "promotions",
      label: "Promotions",
      required: false,
      configured: promotionsConfigured,
      note: promotionsConfigured ? "Promotion configured" : "Optional, can be added later",
    }),
  ];

  const requiredSections = sections.filter((section) => section.required);
  const incompleteRequired = requiredSections.filter((section) => !section.complete);
  const requiredCompletedCount = requiredSections.length - incompleteRequired.length;
  const optionalConfiguredCount = sections.filter((section) => !section.required && section.configured).length;

  return {
    sections,
    requiredCompletedCount,
    requiredTotal: requiredSections.length,
    optionalConfiguredCount,
    optionalTotal: sections.length - requiredSections.length,
    requiredComplete: incompleteRequired.length === 0,
    incompleteRequired,
    protectedGuardrails: protectedGuardrails(config),
    channelContract: purchasedChannelContract(env),
  };
}

function isFreshClientSetupCandidate(config = {}, status = evaluateClientSetup(config)) {
  const source = text(config?.industrySetup?.source);
  if (!profileConfirmed(config)) return false;
  if (!["environment", "setup_status"].includes(source)) return false;
  if (!isPlaceholderBusinessName(config.businessName || config.clinicName)) return false;
  return !status.requiredComplete;
}

module.exports = {
  PLACEHOLDER_BUSINESS_NAMES,
  evaluateClientSetup,
  isFreshClientSetupCandidate,
  isPlaceholderBusinessName,
  protectedGuardrails,
  purchasedChannelContract,
};
