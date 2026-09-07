const PROFILE_UI = {
  aesthetic_clinic: {
    businessNoun: "clinic",
    businessNameLabel: "Clinic name",
    businessAndAiLabel: "Clinic & AI",
    locationsLabel: "Branches",
    locationSingular: "branch",
    locationPlural: "branches",
    servicesLabel: "Treatments",
    serviceSingular: "treatment",
    servicePlural: "treatments",
  },
  home_renovation: {
    businessNoun: "business",
    businessNameLabel: "Business name",
    businessAndAiLabel: "Business & AI",
    locationsLabel: "Locations",
    locationSingular: "location",
    locationPlural: "locations",
    servicesLabel: "Renovation Services",
    serviceSingular: "service",
    servicePlural: "services",
  },
  generic: {
    businessNoun: "business",
    businessNameLabel: "Business name",
    businessAndAiLabel: "Business & AI",
    locationsLabel: "Locations",
    locationSingular: "location",
    locationPlural: "locations",
    servicesLabel: "Services",
    serviceSingular: "service",
    servicePlural: "services",
  },
};

const DEFAULT_PROFILE = PROFILE_UI.generic;

export function getBusinessTerminology(config = {}) {
  const businessType = String(config?.businessType || "generic").trim();
  const profile = PROFILE_UI[businessType] || DEFAULT_PROFILE;
  const configured = config?.terminology || {};

  return {
    businessType,
    ...profile,
    customerSingular: String(configured.customerSingular || "customer").trim() || "customer",
    customerPlural: String(configured.customerPlural || "customers").trim() || "customers",
  };
}

export function getSettingsTabs(config = {}) {
  const ui = getBusinessTerminology(config);
  return [
    { id: "general", label: "General" },
    { id: "branches", label: ui.locationsLabel },
    { id: "hours", label: "Hours & Contact" },
    { id: "services", label: ui.servicesLabel },
    { id: "aliases", label: "Service Terms" },
    { id: "faqs", label: "FAQs" },
    { id: "promotions", label: "Promotions" },
    { id: "aiBehavior", label: "AI Behavior" },
    { id: "escalation", label: "Handoff & Rules" },
  ];
}
