const PROFILE_UI = {
  aesthetic_clinic: {
    businessNoun: "clinic",
    businessNameLabel: "Clinic name",
    businessAndAiLabel: "Clinic & AI",
    locationsLabel: "Branches",
    locationLabel: "Branch",
    locationSingular: "branch",
    locationPlural: "branches",
    servicesLabel: "Treatments",
    serviceSingular: "treatment",
    servicePlural: "treatments",
    serviceInterestLabel: "Treatment interest",
    serviceInterestFallback: "Treatment not selected",
    insightsInterestLabel: "Treatment / Interest",
    preferredLocationLabel: "Preferred Branch",
    conversionLabel: "Appointment",
    conversionStatusLabel: "Appointment status",
    conversionDateTimeLabel: "Appointment date and time",
    conversionCountSingular: "appointment",
    conversionCountPlural: "appointments",
    staffLocationLabel: "Sales branch",
    noFixedLocationLabel: "No fixed branch",
    conversionStatusOptions: [
      ["none", "No appointment"],
      ["set", "Appointment set"],
      ["reschedule", "Needs reschedule"],
      ["cancelled", "Cancelled"],
      ["visited", "Visited clinic"],
    ],
  },
  home_renovation: {
    businessNoun: "business",
    businessNameLabel: "Business name",
    businessAndAiLabel: "Business & AI",
    locationsLabel: "Locations",
    locationLabel: "Location",
    locationSingular: "location",
    locationPlural: "locations",
    servicesLabel: "Renovation Services",
    serviceSingular: "service",
    servicePlural: "services",
    serviceInterestLabel: "Service / project interest",
    serviceInterestFallback: "Service not selected",
    insightsInterestLabel: "Service / Project Interest",
    preferredLocationLabel: "Preferred Location",
    conversionLabel: "Next step",
    conversionStatusLabel: "Next-step status",
    conversionDateTimeLabel: "Next-step date and time",
    conversionCountSingular: "next step",
    conversionCountPlural: "next steps",
    staffLocationLabel: "Sales location",
    noFixedLocationLabel: "No fixed location",
    conversionStatusOptions: [
      ["none", "No next step"],
      ["set", "Next step set"],
      ["reschedule", "Needs reschedule"],
      ["cancelled", "Cancelled"],
      ["visited", "Visited / completed"],
    ],
  },
  generic: {
    businessNoun: "business",
    businessNameLabel: "Business name",
    businessAndAiLabel: "Business & AI",
    locationsLabel: "Locations",
    locationLabel: "Location",
    locationSingular: "location",
    locationPlural: "locations",
    servicesLabel: "Services",
    serviceSingular: "service",
    servicePlural: "services",
    serviceInterestLabel: "Service interest",
    serviceInterestFallback: "Service not selected",
    insightsInterestLabel: "Service / Interest",
    preferredLocationLabel: "Preferred Location",
    conversionLabel: "Next step",
    conversionStatusLabel: "Next-step status",
    conversionDateTimeLabel: "Next-step date and time",
    conversionCountSingular: "next step",
    conversionCountPlural: "next steps",
    staffLocationLabel: "Sales location",
    noFixedLocationLabel: "No fixed location",
    conversionStatusOptions: [
      ["none", "No next step"],
      ["set", "Next step set"],
      ["reschedule", "Needs reschedule"],
      ["cancelled", "Cancelled"],
      ["visited", "Visited / completed"],
    ],
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
